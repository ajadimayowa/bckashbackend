# Phase 6 Notes — Groups (lifecycle, membership, leadership roles)

`src/modules/groups/`. **188 unit tests passing** (up from 160 — 27 new,
covering Groups), 1 e2e test, `npm audit --omit=dev` → 0 vulnerabilities.
Full build/lint/format/typecheck all clean, plus a boot smoke test confirming
the app boots against `mongodb-memory-server` with all four new GROUP*/
GROUP_MEMBERSHIP workflow chains registering with the right step counts, and
the RBAC seed correctly giving MANAGER review / ADMIN+SUPERADMIN
approve+reassign / MARKETER initiate capabilities.

## 1. The Phase 5 two-step chain correction — confirmed, and fixed

You asked me to re-check whether "reviewed and approved" (used identically
for both group creation and customer onboarding in the brief) implies a
two-step Reviewer→Approver chain rather than Phase 5's single-step reading.

**Confirmed the correction, not the original reading.** Two things settled
it beyond just re-reading the sentence:

- `reviewCapability()` already existed as a fully-built, unused helper in
  `platform/rbac/constants/capabilities.ts` since Phase 2.
- `DEFAULT_ROLE_CAPABILITIES` (also Phase 2) already gives MANAGER the
  *review* capability across `MAKER_ENTITY_TYPES` — which already included
  `GROUP` — while ADMIN/SUPERADMIN/APPROVER get *approve*. The two-step shape
  was already designed into the RBAC seed data; Phase 5 just never used it
  for `CUSTOMER`.

**Fixed**: `CustomerService.onModuleInit()`'s `CUSTOMER/CREATE` chain is now
two steps (`workflow:review:CUSTOMER` → `workflow:approve:CUSTOMER`).
`customer.service.spec.ts` updated: the existing approval test now drives
both steps with distinct reviewer/approver actors and asserts the
intermediate `PENDING_REVIEW` → `PENDING_APPROVAL` transition; the rejection
test now rejects at the review step; a new test covers rejection at the
approval step (after a passing review) for symmetry.

**One caveat worth flagging explicitly**: `registerChainConfig` is
idempotent via `$setOnInsert` — it only inserts a chain config if none
exists yet for `(entityType, action)`, specifically so an Admin's later
manual edits survive redeploys. This app has never been deployed, so there's
no persisted stale single-step config anywhere today — but if it ever had
been, this code change alone would **not** retroactively fix an
already-inserted single-step `CUSTOMER/CREATE` config in a real database; a
one-time manual migration (or a future chain-editing endpoint) would be
needed. Noting this now so it isn't a surprise later.

## 2. Groups built two-step from the start, per the same corrected reading

- `GROUP/CREATE`: two steps (`workflow:review:GROUP` → `workflow:approve:GROUP`).
- `GROUP_MEMBERSHIP/ADD`: two steps, same pattern, new entity type.
- `GROUP_MEMBERSHIP/REMOVE`: two steps — see §4 below for why this exists at all.
- `GROUP/REASSIGN_LEADERSHIP`: **single** step — see §5.

`WorkflowEntityType.GROUP_MEMBERSHIP` was added to the shared enum
(`common/enums/workflow.enums.ts`) and to `MAKER_ENTITY_TYPES` in
`default-role-capabilities.ts`, so MARKETER/MANAGER automatically get
initiate/review and ADMIN/SUPERADMIN/APPROVER automatically get
approve (they already map over `ALL_WORKFLOW_ENTITY_TYPES`) — no other RBAC
seed changes needed.

## 3. A stale Phase 2 placeholder found and superseded

`src/common/enums/group.enums.ts` already existed — committed in Phase 2
(`ed7e3e0`) as forward-looking scaffolding, before this phase's actual spec
existed. It declared `GroupStatus` with `DRAFT`/`PENDING_REVIEW`/
`PENDING_APPROVAL`/`APPROVED`/`REJECTED` and a `LeadershipRole` enum
(including `MEMBER`) — neither matching this phase's explicit spec
(`GroupStatus = "ACTIVE" | "REJECTED"`, no PENDING_* on Group itself, same
as Staff). Confirmed via grep that nothing in the codebase referenced either
export, so it was safe to replace outright rather than needing a migration.
Rewrote it to match this phase's actual types (`GroupMemberRole`, not
`LeadershipRole`) and added `LEADERSHIP_ROLES`. Flagging this rather than
silently overwriting it, per the project's own "surface what you find,
don't just proceed" convention.

## 4. Member removal — confirmed workflow-mediated

Adopted your stated default: removal goes through the same two-step
`GROUP_MEMBERSHIP` chain as addition (action `REMOVE`), for the same
"financial-adjacent, worth a second set of eyes" reasoning. `initiateMemberRemoval`
checks the "no active membership" and "no pending loan" guards *before*
calling the workflow engine — no `WorkflowRequest` is ever created for a
removal that can't pass those checks.

## 5. `reassignLeadershipRole` — my call on the open design points

Two things were explicitly left to me, documented here as asked:

**Single-step, not two-step.** The chain (`GROUP/REASSIGN_LEADERSHIP`) has
one step requiring `workflow:approve:GROUP`. Reasoning: this is a narrow,
already Admin/SuperAdmin-gated corrective action (filling a vacancy), not a
fresh financial commitment like creating a group or adding a member — but it
still isn't a bare direct action either, since maker-checker still applies
(whoever *initiates* it can't also be the one who approves it, per the
engine's own maker≠checker rule). To keep initiation itself narrower than
ordinary group activity, a new flat capability `group:reassign_leadership`
(`GROUP_REASSIGN_LEADERSHIP_CAPABILITY`) gates who can even call
`reassignLeadershipRole` — seeded to ADMIN and SUPERADMIN only, *not*
MARKETER/MANAGER (who hold the generic `workflow:initiate:GROUP` but not
this one) and *not* APPROVER (who holds `workflow:approve:GROUP` for the
single approval step, but not this initiate-gate). So filling a vacant
leadership role requires two different Admin/SuperAdmin/Approver-tier staff
members to act (one to initiate, one to approve), not just one.

**Does NOT require `newCustomerId` to already be an active member.** The
brief didn't say either way. Forcing a separate "add as member first" step
before this already-gated, already-workflow-approved action seemed like pure
friction with no safety benefit. On approval: if `newCustomerId` already has
an active membership (any role, including a plain `MEMBER`), that row is
closed (`leftAt` set, `removalReason: "Reassigned to <ROLE>"`) and a new row
opens with the leadership role — same close-old/open-new convention already
established by `BranchManagerAssignmentService.assignManager`
(`branches/branch-manager-assignment.service.ts`). If they have no active
membership at all, a fresh row is created directly — this single call can
both bring in a new member *and* immediately make them a leader.

## 6. `isEligibleForLoanApplication` — the below-3-members assumption, confirmed and implemented

Implemented as you flagged it: a group that has dropped below 3 active
members via removals is treated as ineligible for a *fresh* loan
application, not just a hard floor at creation time. One necessary
adjustment to the brief's literal return shape: `{ customerId: ObjectId;
reason: string }[]` has no slot for a reason that isn't about one specific
member. `IneligibleMember.customerId` is `string | null` — `null`
specifically for this group-level "too few active members" case. Tested
directly (`isEligibleForLoanApplication` test suite): per-member
KYC-incomplete reasons, the group-level under-3 reason, and the
fully-eligible case are all covered separately.

## 7. LoanStatusPort — TEMPORARY, must be rebound in Phase 8

**This is the single most important cross-phase dependency from this
module.** `src/modules/groups/interfaces/loan-status-port.interface.ts`
defines `LoanStatusPort.hasPendingLoan(customerId): Promise<boolean>`,
injected via the `LOAN_STATUS_PORT` token. `groups.module.ts` currently
binds it to `StubLoanStatusPort` (`src/modules/groups/loan-status/`), which
**always returns `false`** — correct only because no Loan collection exists
yet anywhere in this codebase. A test
(`initiateMemberRemoval > is blocked when LoanStatusPort.hasPendingLoan
returns true`) proves the guard is genuinely wired up and would block
removal the moment a real implementation says `true` — using a test double,
not the stub, so this doesn't just test that the stub always says no.

**Phase 8 must**: implement a real `LoanStatusPort` backed by the actual
Loan collection, and change the `useClass`/`useExisting` binding for
`LOAN_STATUS_PORT` in `groups.module.ts`. Loudly commented at all three
relevant places (the interface file, the stub file, and the module
registration) so this isn't missed during Phase 8 review.

## 8. A real bug found while building this phase's tests — write-side ObjectId casting

**Not previously known, and worth flagging clearly**: Phase 5's KycRecord
bug (documented in PHASE_5_NOTES.md) was a *query-side* casting failure —
a plain ID string in a `.findOne()` filter silently matching zero documents
against an ObjectId-typed field. Building this phase's tests surfaced a
**write-side** version of the same underlying issue: calling
`Model.create({ groupId: someIdString, ... })` — a single plain object, no
session — did **not** reliably cast `someIdString` to a real `ObjectId` on
save. The field was persisted as a raw BSON string. Confirmed empirically
(not just suspected): a document written this way returned
`groupId instanceof Types.ObjectId === false`, and a `.lean()` read showed
`typeof groupId === 'string'` with no `_bsontype`, while a sibling document
created via an array-form `.create([...], { session })` call with an
already-real `ObjectId` (never needing a cast) stored correctly. Any later
query filtering with an explicit `new Types.ObjectId(...)` (the established,
correct defensive pattern from the Phase 5 fix) would then silently exclude
that document.

**Fix**: every place in `groups.service.ts` that writes a plain ID string
coming out of a `WorkflowRequest`'s opaque payload/`event.initiatedBy` into
an ObjectId-typed field now explicitly wraps it in `new Types.ObjectId(...)`
— covers `onGroupCreationApproved`, `onMemberAdditionApproved`,
`onMemberRemovalApproved`, and `onLeadershipReassignmentApproved` (both the
query filters *and* the `$set`/`create()` write payloads). This is the same
defensive discipline the codebase already uses for query filters, just
proven to also be necessary on the write side — worth keeping in mind for
Phase 8 (Loans) and any other future module that creates documents from a
`WorkflowApprovedEvent.payload`.

I did **not** go back and retrofit Staff/Customer's existing `.create()`
calls (`payload.departmentId`, `payload.branchId`, etc. in
`staff.service.ts`, `payload.branchId` in `customer.service.ts`) — their
existing test suites pass, meaning nothing currently queries those written
fields with an explicit ObjectId-cast filter that would expose the same
issue, and blind "fix" attempts on code with passing tests already burned
time in Phase 5 (see that phase's "near-miss" note) without proving a real
problem existed there. Flagging as a known risk worth a second look if a
future phase adds an ObjectId-cast query against one of those fields and
gets an unexplained empty result.

## Deliverable

- `src/modules/groups/`: `Group`/`GroupMembership` schemas (with the
  three-separate-partial-indexes pattern for leadership-role uniqueness —
  MongoDB's `partialFilterExpression` doesn't support `$in`, only equality/
  `$exists`/`$gt(e)`/`$lt(e)`/`$type`/top-level `$and`, so one index per
  leadership role rather than one combined index), `GroupsService`,
  `GroupsController`, `GroupsModule`, `LoanStatusPort` + stub, DTOs.
- 27 new tests (`groups.service.spec.ts`) covering every item in the
  required-tests list: sub-3-member rejection before any WorkflowRequest,
  no persistence until approval (rejection leaves nothing behind),
  leadership-by-array-order assignment, the partial unique indexes violated
  directly at the DB layer (bypassing the service), one active membership
  per customer per group, pending additions invisible to
  `getActiveMembers`/eligibility, the LoanStatusPort guard proven with a
  test double returning `true`, vacant-role-no-auto-promotion on removal,
  `reassignLeadershipRole` filling a vacancy and being blocked when already
  held, per-member ineligibility reasons (KYC + below-3), and
  `getLeadership` returning `undefined` rather than throwing for a vacant
  role.
- `CustomerService`'s `CUSTOMER/CREATE` chain corrected to two steps (§1).

Do not start Phase 7 until this is reviewed.
