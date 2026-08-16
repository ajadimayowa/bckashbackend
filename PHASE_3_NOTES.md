# Phase 3 Notes — Identity & Branches

`src/modules/identity/` (departments, units, staff, auth) and `src/modules/branches/`
(branch entity + manager assignment history only — bank accounts/funding are Phase 4).
**90 unit tests passing** (`npm test`), plus a full-app boot smoke test against a real
(in-memory) MongoDB confirming every route maps, the RBAC seed includes the new
capabilities, and the `STAFF/CREATE` chain registers itself on boot.

## Decisions you asked to have flagged explicitly

### 1. Org-structure CRUD vs. workflow engine
Department/Unit/Branch CRUD is **not** routed through the workflow engine — plain
Admin/SuperAdmin CRUD gated by a new flat capability, `org:manage` (granted to
ADMIN and SUPERADMIN in the default seed). This matches your own default lean:
low-risk, easily reversible, no real maker-checker value in renaming a department.
If you'd rather these go through maker-checker too (e.g. because branch codes feed
downstream reports and a bad edit is more disruptive than it looks), it's a small
change — swap the controllers' `@RequireCapability(ORG_MANAGE_CAPABILITY)` guard
for a workflow-engine `initiate()` call, same pattern as staff onboarding.

### 2. Token invalidation on disable
Chose **short-lived access token + live status check** over a revocation list, per
your own lean. Two mechanisms, one per token type:
- **Access token** (JWT, 15 min default): `JwtStrategy.validate()` does a `Staff.findById(...).select('status')`
  lookup on *every* authenticated request and rejects if not `ACTIVE`. This runs
  after Passport has already verified the token's signature/expiry — so this is
  specifically "a structurally-valid token gets rejected anyway," proven directly
  in `strategies/jwt.strategy.spec.ts`.
- **Refresh token** (opaque random value, hashed at rest, 7 days default):
  `StaffService.disable()` calls `RefreshTokenService.revokeAllForStaff()`, so a
  disabled account can't mint a *new* access token either, even before its old one expires.
- **Tradeoff accepted**: every authenticated request now costs one extra Mongo
  read (the status lookup), on top of RBAC's own two reads (role capabilities +
  module access) from Phase 2 — three reads per request at this point. Fine at
  this scale; if it ever matters, the obvious next step is a short-TTL
  (10–30s) cache of `{staffId → status}`, not a switch to revocation-list-only
  (which reintroduces the "still valid until the list is checked" gap this
  design avoids).
- **Refresh token rotation** (not explicitly requested, added anyway): every
  `POST /auth/refresh` revokes the token it was given and issues a new one.
  Standard practice for long-lived bearer tokens, low cost to add, tested in
  `auth.service.spec.ts`.

### 3. Non-Marketer onboarding
Implemented exactly your suggested placeholder: `POST /staff/direct` lets a
SuperAdmin (capability `staff:create-direct`, SUPERADMIN-only in the seed)
directly create **MANAGER, ADMIN, or APPROVER** accounts, `status: ACTIVE`
immediately, no workflow. `CreateStaffDirectDto.role` is type-restricted to
exactly those three values.

**Open question, not answered by this phase**: nothing creates the *first*
SUPERADMIN. `staff:create-direct` itself is gated by a capability only a
SUPERADMIN holds, and the DTO excludes creating another SUPERADMIN even for
those who do — so there's currently no path from an empty database to a
working system. This needs a bootstrap mechanism (seed script, one-time CLI
command, or an env-var-gated bootstrap endpoint) before this is deployable —
flagging rather than guessing at which approach you'd want.

## Other flagged assumptions

- **Capability naming**: the brief's own prose used `staff:approve` for the
  onboarding chain's step and implied `org:manage` for CRUD. I used
  `workflow:approve:STAFF` (Phase 2's established `workflow:<step>:<entityType>`
  convention — and already seeded to ADMIN/SUPERADMIN/APPROVER) instead of a new
  ad-hoc `staff:approve` string, to avoid two parallel capability-naming schemes
  for the same concept. `org:manage` and `staff:create-direct` are new flat
  capabilities, added to `platform/rbac/constants/capabilities.ts` alongside the
  existing `staff:disable`/`rbac:manage`.
- **Branch manager role restriction**: `assignManager` requires the target staff
  member to have role `MANAGER` (and be `ACTIVE`) — the brief flagged this as
  ambiguous ("confirm if other roles can be branch managers"). "Branch Manager"
  as a phrase is used throughout the brief in a way that strongly implies the
  `MANAGER` role specifically, so I went with that rather than leaving it open,
  but flagging per your explicit ask.
- **Cross-module data access without `forwardRef`**: `StaffService` needs to
  validate a `branchId` exists (Branch lives in `branches`); `BranchManagerAssignmentService`
  needs to validate a `staffId` has role `MANAGER` (Staff lives in `identity`).
  Rather than `forwardRef()`-ing the two modules into each other, each module
  independently registers the *other's* schema via `MongooseModule.forFeature`
  and injects the raw model directly (`@InjectModel(Branch.name)` inside
  `staff.service.ts`, `@InjectModel(Staff.name)` inside
  `branch-manager-assignment.service.ts`) — never each other's Service or Module.
  Net effect: `BranchesModule` imports `IdentityModule` (for `JwtAuthGuard`) but
  `IdentityModule` has zero NestJS-module-level dependency on `BranchesModule`.
  One-directional, no `forwardRef` needed, and easy to verify has no cycle (see
  the module import graph in `identity.module.ts` / `branches.module.ts`).
- **Password hashing point**: bcrypt-hashed *before* `WorkflowEngineService.initiate()`
  is ever called for staff onboarding — a plaintext password must never sit in a
  `WorkflowRequest.payloadHistory` document waiting for Admin/Approver review.
  The workflow payload carries `passwordHash`, not `password`; `StaffService.handleWorkflowApproved`
  uses the hash as-is.
- **Response shape for workflow-initiation endpoints**: `POST /staff/onboard`
  returns a new `WorkflowRequestSummaryDto` (id/status/entityType/action/etc.)
  rather than the raw `WorkflowRequest`, specifically because the raw document's
  `payloadHistory` would otherwise leak the bcrypt `passwordHash` over the API.
  This is a general-purpose DTO in `platform/workflow-engine/dto/` — any future
  module initiating a workflow with a sensitive payload should reuse it rather
  than returning the raw request.
- **`passwordHash` double defense**: `select: false` at the schema level (never
  returned by a default query) *and* a hand-built `StaffResponseDto` with an
  explicit field whitelist (never returned by any controller, even if some
  future code path explicitly re-selects the hash for internal use, as
  `AuthService` does for login). Both defenses are tested directly in
  `dto/staff-response.dto.spec.ts`.

## A Phase 2 bug found and fixed here

`WorkflowEngineService.act()`/`resubmit()` were calling `eventEmitter.emit(...)`
(fire-and-forget) rather than `emitAsync(...)` (awaited). This meant a caller of
`act()` — e.g. a controller approving a staff onboarding request — could not
trust that `workflow.approved`'s reaction (creating the Staff record) had
actually finished before the HTTP response went out; the Staff record's
creation was racing the response. Found while wiring Phase 3's first real event
consumer, fixed by switching to `emitAsync` + `await` in all four emit sites.
Phase 2's existing 24 tests still pass unmodified after the change.

## Also done, not explicitly requested

- **`RbacModule` and `AuditModule` marked `@Global()`.** Every domain module
  from here on needs RBAC guards and the audit service on essentially every
  controller — importing both by hand in every future module (groups, loans,
  repayments, ...) would be pure boilerplate. Low-risk change (a module
  decorator, not new logic); Phase 2's own tests are unaffected.
- A small `InMemoryMongo`-based test-utils helper (`test-jwt-config.module.ts`)
  for tests that need `ConfigService.get('jwt')` without the full Joi-validated
  env schema.

## Deferred / not built in this phase

- Branch bank accounts and funding — Phase 4, per your instruction.
- Fine-grained read permissions (e.g. "a staff member can view their own
  profile without `org:manage`") — every `GET` on staff/departments/units/branches
  is currently gated by the same admin-level capability as the CRUD mutations.
  Reasonable to defer; flagging so it doesn't look like an oversight.
- Re-validating department/unit/branch references at *approval* time (only
  validated at *initiation* time) — if a department is deactivated between a
  marketer's onboarding submission and an admin's approval, the approval still
  succeeds. Same category of concern as the brief's own "re-validate KYC status
  at loan application time" pattern elsewhere; flagging as a parallel case worth
  the same treatment in a hardening pass, not built now.

Ready for Phase 4 (branch bank accounts + funding, materialized fund balance)
once you've had a look at the above — particularly the SuperAdmin-bootstrap gap,
which will block actually standing up a working system end-to-end.
