# Phase 2 Notes — Platform Layer

Workflow engine, RBAC, and audit module — all under `src/platform/`, registered in
`AppModule`, with 55 unit tests passing (`npm test`) plus a manual full-app boot
smoke test against a real (in-memory) MongoDB. Nothing in this phase references
loans, groups, customers, or any other domain concept.

## What was built

### `src/platform/audit/`
- `AuditLog` schema — `actorId | null`, `action`, `entityType`, `entityId`,
  `before?`, `after?`, `metadata?`, `timestamp`. Indexed on `(entityType, entityId, timestamp)`,
  `(actorId, timestamp)`, `(action, timestamp)`.
- `AuditService` — `record()`, `findByEntity()`, `findByActor()` only. No
  update/delete method exists on the class at all (not just unused — not
  declared), and the Mongoose model is a private constructor param, so nothing
  outside the class can reach past it either. A test asserts the method list
  directly (`Object.getOwnPropertyNames(prototype)`).

### `src/platform/rbac/`
- `RoleCapabilities` (role → `string[]`, unique on `role`) and
  `StaffModuleAccess` (`staffId` → `ModuleName[]`, unique on `staffId`) schemas.
- Default capability seed (`constants/default-role-capabilities.ts`) — see
  **Assumption 1** below. Seeded via `RbacService.onModuleInit()` using
  `$setOnInsert` + upsert, so it only fills in roles with no document yet —
  never clobbers an Admin's later edits. Verified with a test that edits
  MARKETER's capabilities, re-runs `onModuleInit()`, and confirms the edit survives.
- `RequireCapability` / `RequireModule` decorators (`SetMetadata`), and three
  guards: `StaffContextGuard` (resolves `request.user` → `request.staffContext`),
  `CapabilityGuard`, `ModuleAccessGuard` — independently checkable, composable
  on the same route.
- `RbacController` — `GET /rbac/role-capabilities`,
  `PUT /rbac/role-capabilities/:role`, `PUT /rbac/staff-module-access/:staffId`,
  all gated behind `rbac:manage` (only SUPERADMIN holds it by default).

### `src/platform/workflow-engine/`
- `WorkflowChainConfig` schema (`entityType`, `action`, `restartOnReturn`,
  `steps: [{order, requiredCapability}]`, `isActive`), unique on
  `(entityType, action)`. `registerChainConfig()` is upsert-on-insert-only, same
  principle as RBAC's seeding — safe to call on every module init, never
  silently overwrites an existing chain.
- `WorkflowRequest` schema — `entityType`, `entityId: string | null`, `action`,
  `status`, `chainConfigRef`, `steps` (snapshot, each with
  `actedBy/action/comment/actedAt` starting `null`), `currentStepIndex`,
  `payloadHistory`, `initiatedBy`, `branchId`.
- `WorkflowEngineService`:
  - `initiate` / `act` / `resubmit` / `getPendingForActor` / `getHistory`, plus
    `linkEntity` (not in the original spec — see **Addition** below).
  - `act`'s atomic guard: `findOneAndUpdate({_id, status: <status at read time>,
    currentStepIndex: <index at read time>}, ...)`. If another actor already
    transitioned the request, the filter no longer matches, the call returns
    `null`, and the service throws `ConflictException`. Proven with a real
    concurrent-write test against mongodb-memory-server (`Promise.allSettled`
    of two actors approving the same step at once) — exactly one succeeds.
  - Every transition writes to `AuditService` and emits one of
    `workflow.approved` / `workflow.rejected` / `workflow.returned` /
    `workflow.resubmitted` via `EventEmitter2` (global, from
    `EventEmitterModule.forRoot()` in `AppModule`).

## Deviations from the literal spec (flagged as instructed, not applied silently)

**1. `act`/`getPendingForActor` take the actor's capabilities as a parameter,
not just a `staffId`.**
Literal spec: `act(workflowRequestId, actorId, action, comment?)`. Resolving
capabilities from a bare `staffId` requires knowing the actor's *role*
(`staffId → role` is Identity's job, Phase 3 — doesn't exist yet), then
`role → capabilities` (RBAC). Rather than give the engine a hard dependency on
RBAC (and transitively on Identity, once RBAC needs staffId→role), the engine
now takes `actor: { staffId, capabilities }` — the caller (a controller, which
already ran `StaffContextGuard` + friends and has `request.staffContext.capabilities`)
resolves and passes it in. Net effect: **the workflow engine has zero
dependency on `rbac` or any future `identity` module** — it's not just
entity-agnostic, it's identity-agnostic too. You confirmed this approach when asked.

**2. Status-mapping convention for chains with more than 2 steps.**
`status = PENDING_APPROVAL` when `currentStepIndex` is the last step, else
`PENDING_REVIEW` — derived purely from position, no extra per-step config. You
confirmed this over the alternative (an explicit `phase` field per step) when asked.

**3. `entityId` / `initiatedBy` / `actedBy` / `submittedBy` / `staffId` typed
as `string`, not `ObjectId`.**
The literal `WorkflowRequest` interface types `entityId` as `ObjectId | null`
but `initiatedBy` etc. as `string`. Using `ObjectId` for `entityId` while
`initiatedBy` stays `string` is an inconsistency I didn't carry forward —
everything id-shaped is a plain `string` throughout this phase, matching
`AuditLogEntry`'s own `entityId: string` and avoiding ObjectId-cast friction
against staff/entities that don't have real Mongoose models yet. Low-risk,
purely a data-type choice, not a business-logic assumption — flagging for
completeness rather than because I think it needs revisiting.

## Assumptions (flagged, not guessed silently)

**1. Default role → capability matrix** (`constants/default-role-capabilities.ts`).
The brief gives per-module hints ("Marketer/Manager initiates,
Admin/SuperAdmin/Approver approves") but no single table. I generalized:
- **MARKETER**: initiate only (`CUSTOMER`, `GROUP`, `LOAN`, `REPAYMENT_RECORD`, `LEAVE_APPLICATION`). No review/approve.
- **MANAGER**: everything MARKETER initiates, plus initiates `STAFF` onboarding, plus reviews everything it can initiate (plus `STAFF`). No approve.
- **ADMIN**: reviews + approves everything, initiates + approves `LOAN_PRODUCT`/`FEE_DEFINITION` config changes, plus `staff:disable`.
- **SUPERADMIN**: superset of ADMIN, plus `rbac:manage` (the only role that can edit this matrix at runtime).
- **APPROVER**: approves everything, nothing else.

This is DB-seeded data (not code), so it's cheap to correct via the
`rbac:manage`-gated endpoint once you confirm the real matrix — but every
subsequent phase's chain registrations will assume these names/capabilities
line up, so **please review before Phase 3+ builds on it**.

**2. Capability naming convention**: `workflow:<initiate|review|approve>:<ENTITY_TYPE>`,
scoped to entity type only (not per-action) — matches the two examples you gave
(`workflow:review:GROUP`, `workflow:approve:LOAN`). `WorkflowEntityType` enum in
`common/enums/workflow.enums.ts` (`STAFF`, `CUSTOMER`, `GROUP`, `LOAN`,
`LOAN_PRODUCT`, `FEE_DEFINITION`, `REPAYMENT_RECORD`, `LEAVE_APPLICATION`) is a
non-exhaustive shared vocabulary for this — the engine itself never imports or
checks against it; it's purely for RBAC seed data and future domain modules to
stay consistent.

**3. `resubmit` clears only the returned step when `restartOnReturn: false`,**
not the whole chain (which stays untouched only for steps *before* the
returned one). This wasn't fully specified — the alternative (leaving the
returned step's own record in place) would make it permanently unactionable,
since the "same actor can't act twice" rule would then block the very reviewer
who's supposed to look at it again. Confirmed this reading is internally
consistent via a test that has the same approver act again after resubmission.

## Addition beyond the spec

`WorkflowEngineService.linkEntity(workflowRequestId, entityId)` — not in the
original spec. `entityId` starts `null` for "create" flows (there's no entity
until the domain module creates one after `workflow.approved`). Without a way
to backfill it, `getHistory(entityType, entityId)` would never find the
original creation request once the entity exists. Domain modules should call
this right after creating their entity in their `workflow.approved` listener.

## Open questions for you before Phase 3

1. **The role → capability matrix above** — please confirm or correct it.
   Specifically: should MANAGER be able to *approve* anything (not just
   review), and should ADMIN's `LOAN_PRODUCT`/`FEE_DEFINITION` initiate
   capability also extend to SUPERADMIN, or is SUPERADMIN meant to be
   approval-only for those (i.e. never the initiator)?
2. **`rbac:manage` and `staff:disable`** were placed on ADMIN+SUPERADMIN and
   SUPERADMIN-only respectively, by my own judgment call, not from an explicit
   brief statement beyond "Admin/SuperAdmin can disable any staff account" —
   confirm SUPERADMIN-only is right for `rbac:manage` specifically (editing the
   permission model itself feels like it should be the narrowest-held
   capability of all, but that's my call, not yours).
3. Once Identity (Phase 3) exists and a real JWT auth guard populates
   `request.user`, confirm the JWT payload will carry exactly `{ staffId, role,
   branchId }` — that's the contract `StaffContextGuard` currently assumes
   (`AuthenticatedStaffPrincipal` in `platform/rbac/interfaces/staff-context.interface.ts`).

Ready for Phase 3 (Identity) once you've had a look at the above — tests are
green (`npm test`, `npm run test:e2e`, `npm run lint`, `npm run typecheck`,
`npm run build` all pass).
