# Phase 12 Notes — HR (leave management, salary structure)

`src/modules/hr/`. **413 unit tests passing** (up from 382 — 31 new), 5 e2e
tests, `npm audit --omit=dev` → 0 vulnerabilities. Full typecheck/lint/
format/build clean. Boot smoke test run against the real Atlas dev DB and
deleted (see "Boot smoke test" below).

This is the **final phase of the 12-phase build** — the most self-contained
one, with no forward-dependency port for a later phase to rebind. It
consumes the workflow engine, RBAC, audit, and encryption services built in
earlier phases rather than building equivalents, per the brief's own
framing.

## The four flagged assumptions — confirmation requested for each

**§1 Leave day-counting — calendar days, inclusive of both endpoints.**
Implemented exactly as flagged: `numberOfDays = round((endDate - startDate) /
MS_PER_DAY) + 1`. A single-day application (`startDate === endDate`) counts
as 1 day. **If the coop wants weekends/public holidays excluded, this is a
different calculation** (would need a holiday calendar and a working-day
count instead of a calendar-day count) — confirm before treating the
current behavior as final.

**§2 Insufficient leave balance never blocks submission.** Implemented as
specified: `applyForLeave` always creates the `LeaveApplication` and
initiates the workflow regardless of the applicant's remaining balance.
`balanceShortfallFlagged`/`balanceShortfallDays` are computed once at
submission and stored on the application (not recomputed later, so what the
reviewer saw can't silently drift) — a reviewer/approver sees the shortfall
in the record but nothing in this codebase auto-converts the excess to
"unpaid" or any other special handling; that's left entirely as a human
decision baked into whether they approve at all, matching the brief's own
"the reviewer/approver decides" framing. Confirm this is the intended
degree of automation (none, beyond surfacing the number).

**§3 Payroll disbursement is out of scope — confirmed as a scoping
boundary, not silently assumed.** `SalaryRecord` captures structure and
history only (what a staff member is owed and when it changed) — no tax/
pension deduction logic, no bank disbursement, no payslip generation exists
anywhere in this module. **Explicitly flagging this as a real scoping
decision requiring confirmation**, not something to treat as obviously
correct — a coop that expects this phase to also handle running payroll
will find nothing here for that; it would need its own phase, with its own
NG-compliance-level detail the brief didn't provide.

**§4 Salary approval — single-step, Admin/SuperAdmin, workflow-mediated.**
Implemented as `WorkflowEntityType.SALARY_RECORD` (new this phase), one
step requiring `approveCapability(SALARY_RECORD)` — an Admin/SuperAdmin
proposes, a *different* Admin/SuperAdmin/Approver approves (the engine's own
maker-can't-act-on-own-request + same-actor-can't-act-twice rules make this
automatic, no bespoke enforcement needed). Confirm — the brief itself notes
this isn't explicitly described for salary specifically, generalized from
this system's existing "financial-adjacent config gets a second set of
eyes" pattern (chart-of-accounts mapping, loan product changes).

## `LEAVE_APPLICATION`, not a new `LEAVE` entityType

The brief's own chain names ("LEAVE/APPROVE_STAFF" etc.) are shorthand —
reconciled onto the pre-existing `WorkflowEntityType.LEAVE_APPLICATION`
value (already present since Phase 1/2, already in `MAKER_ENTITY_TYPES` for
MARKETER/MANAGER's `initiateCapability` grants) rather than introducing a
parallel `LEAVE` entity type. Same reconciliation category as Phase 10's
`JournalSourceEvent` mapping. Three chains registered under this one
entityType, distinguished by `action` (`APPROVE_STAFF`/`APPROVE_MANAGER`/
`APPROVE_ADMIN` — new `LeaveChainAction` enum).

## The three leave chains — derived entirely from existing capabilities, no new ones needed

- **`APPROVE_STAFF`** (Marketers, non-managing Managers, Approvers-as-
  applicants — though Approvers never actually apply via this codebase's
  gating, see below): `[reviewCapability(LEAVE_APPLICATION), approveCapability(LEAVE_APPLICATION)]`.
  Review is held by any Manager (not staff-id-scoped to "the applicant's
  own" branch manager specifically — the capability is generic; a stricter
  per-person rule would need service-layer enforcement, same precedent as
  `BranchFundingService`'s "capability gates a manager generically, the
  service enforces 'their own'" — not built here since the brief's own
  pseudocode uses `getCurrentManager` only for chain *selection*, not
  reviewer restriction, see below) and by ADMIN/SUPERADMIN (who hold review
  for everything).
- **`APPROVE_MANAGER`** (the applicant IS the current Branch Manager of
  their own branch): `[approveCapability(LEAVE_APPLICATION), approveCapability(LEAVE_APPLICATION)]`
  — deliberately *approve* capability for **both** steps, not review. MANAGER
  never holds approve-capability for anything in this codebase (confirmed
  precedent, see PHASE_9_NOTES.md), so this structurally excludes every
  Manager — including the applicant themselves — from either step, leaving
  only ADMIN/SUPERADMIN/APPROVER, and the engine's own "same actor can't act
  twice" rule (already covering the *whole* chain, not just adjacent steps —
  confirmed by reading `WorkflowEngineService.act`'s own validation) forces
  two different people. Tested directly (`ForbiddenException` on both a
  self-approve attempt and a plain-Manager review attempt).
- **`APPROVE_ADMIN`** (the applicant is Admin/SuperAdmin):
  `[reviewCapability(LEAVE_APPLICATION), approveCapability(LEAVE_APPLICATION)]`
  — identical capability shape to `APPROVE_STAFF`; what actually
  distinguishes it is simply which applicants get routed here, combined
  with the maker-can't-act-on-own-request guard.

**`getCurrentManager` is used only for chain *selection*** (is the
applicant themselves currently the branch's assigned manager?), not to
restrict who may act as reviewer on `APPROVE_STAFF` — re-reading the
brief's own pseudocode, `BranchManagerAssignmentService.getCurrentManager`
appears specifically in the context of routing, and Phase 11's own
`resolveInvolvedParties` already established the "used for
notification/context, not enforcement" precedent for this exact service
method. Flagging this reading explicitly in case a stricter "only the
applicant's actual current manager may review" enforcement was intended —
that would need a service-layer check inside `WorkflowEngineService.act`'s
caller, which doesn't exist today for any chain in this system.

## `LEAVE_APPLICATION/APPROVE_ADMIN` — the operational risk the brief asked to have surfaced

The brief explicitly flagged needing confirmation on who approves an
Admin's own leave, floating "another SuperAdmin" as an unconfirmed default
and warning that a SuperAdmin-only requirement could become unfulfillable
in a single-SuperAdmin deployment. **Resolved to the more permissive
option**: `APPROVE_ADMIN` reuses `reviewCapability`/`approveCapability(LEAVE_APPLICATION)`,
both held by ADMIN *and* SUPERADMIN equally (this codebase's capability
model doesn't distinguish the two roles at the capability-string level
anywhere) — deliberately **not** a new SuperAdmin-only capability. This
directly reduces the operational risk the brief was worried about: a coop
with one SuperAdmin and one-or-more Admins can still fully process an
Admin's or the SuperAdmin's own leave application, as long as at least two
distinct ADMIN/SUPERADMIN-tier people exist in total. **The residual risk
that remains, flagged for real confirmation**: a coop with **exactly one**
Admin-tier person total (whether that's one SuperAdmin alone, or one Admin
alone) still cannot process that person's own leave application at
all — the chain would sit permanently stuck at step 0 with no eligible
actor. This is a real, observable operational floor (minimum 2 Admin-tier
staff for leave to ever work for the top of the hierarchy), not fully
eliminated by this design, only pushed from "1 SuperAdmin" to "1 Admin-tier
person of any kind."

## Salary encryption and access-restriction design

- **Encrypted before the workflow payload is ever persisted.** Same
  discipline as Phase 3's Staff onboarding hashing a password before it
  ever sits in `WorkflowRequest.payloadHistory` (see
  `StaffService.initiateOnboarding`'s own comment) — `proposeSalaryChange`
  encrypts `baseSalaryKobo`/`allowances` via `EncryptionService` *before*
  calling `WorkflowEngineService.initiate`, so the plaintext salary figure
  never sits in a generic, less-guarded collection waiting for review. The
  `workflow.approved` handler stores the already-encrypted ciphertext
  directly, never round-tripping through plaintext a second time.
- **`allowances` encrypted as a whole** (one `JSON.stringify` blob, one
  ciphertext) — the brief's own "your call, document it." Chosen over
  per-field encryption: simpler (one encrypt/decrypt operation instead of
  N), and there's no use case here for querying into individual allowance
  line items at the database level.
- **Extending Phase 5's field-level PII encryption to salary — flagged for
  confirmation, per the brief's own framing.** The brief itself
  acknowledges salary "wasn't named alongside BVN/NIN explicitly" as
  needing this. Reused `EncryptionService` rather than building a second
  mechanism, on the reasoning that compensation is sensitive HR data by any
  reasonable standard — but this is presented as a reasonable extension,
  not a certainty, and worth an explicit confirm.
- **Storage/decryption pattern matches `Staff.bvnEncrypted`/`KycRecord.bvn`
  exactly**: encryption/decryption happens explicitly in `SalaryService`
  (a DI-friendly service, easily mocked in tests), never via a Mongoose
  schema-level `set`/`get` transform (those run outside Nest's DI
  container — see `EncryptionService`'s own doc comment for why this
  codebase never uses that approach). Tested: the raw DB document's
  `baseSalaryKoboEncrypted` field is asserted to not contain the plaintext
  figure in any form, matches the `<iv>.<authTag>.<ciphertext>` format, and
  decrypts back to the exact original value.
- **Access control**: `HR_SALARY_MANAGE_CAPABILITY` (`hr:salary:manage`) is
  a new, deliberately narrow flat capability — granted only to ADMIN/
  SUPERADMIN, gating both viewing and proposing changes to *another* staff
  member's salary. `GET /hr/salary/mine` has no guard beyond authentication
  (self-access is structural, not a bypassed check — the route has no
  `staffId` path parameter at all, so it can only ever return the caller's
  own current record). Tested end-to-end via a real HTTP-request-driven
  suite (`hr-access-control.spec.ts`) with guard doubles standing in for
  JWT/staff-context resolution (already independently tested elsewhere) so
  the *real* `ModuleAccessGuard`/`CapabilityGuard` combination is what's
  actually exercised.

## Smaller flagged decisions

- **LeaveType CRUD is Admin-gated, not workflow-mediated** — same
  "structural configuration, not a per-case decision" reasoning as
  chart-of-accounts (Phase 10) and org-structure CRUD (Phase 3). New flat
  capability `HR_LEAVE_TYPES_MANAGE_CAPABILITY` (`hr:leave_types:manage`),
  ADMIN/SUPERADMIN only. Flagged per the brief's own explicit request to
  flag this choice.
- **Cancelling an *already-APPROVED* leave application requires a new flat
  capability** (`LEAVE_CANCEL_APPROVED_CAPABILITY`, `leave:cancel_approved`
  — ADMIN/SUPERADMIN only), deliberately **not**
  `approveCapability(LEAVE_APPLICATION)` — APPROVER also holds that
  capability for every entity type, and the brief's own language
  ("Admin/SuperAdmin capability") reads as narrower than "everyone who can
  ever approve a leave step." An Admin/SuperAdmin who is also the applicant
  can, as written, cancel their *own* already-approved leave (the gate is
  capability-based, not identity-based) — a minor, acknowledged edge case
  the brief doesn't address either way.
- **Cancelling a still-PENDING application**: the applicant themselves, or
  anyone holding `LEAVE_CANCEL_APPROVED_CAPABILITY`, may withdraw it — no
  special capability needed for the applicant's own not-yet-decided
  request. Not explicitly specified by the brief; a reasonable default,
  flagged.
- **`apply`/`cancel` require `ModuleName.HR` module access** (not extended
  the self-access exemption) — the brief's own sentence groups "Leave
  application/review/approval" together under "standard HR module access,"
  distinct from the self-access carve-out it named narrowly for the two
  `GET .../mine`-style read endpoints specifically. **Flagged as a real
  operational consequence worth confirming**: a Marketer without HR module
  access literally cannot submit their own leave application under this
  reading — if that's not the intent, this is a one-guard change (drop
  `ModuleAccessGuard`/`@RequireModule` from those two routes).
- **A defensive fix carried forward from Phase 11's own discovery**: every
  new query in this phase that filters on a non-`_id` ObjectId-typed field
  (`staffId`, `leaveTypeId`) explicitly casts the string to `Types.ObjectId`
  before use, rather than trusting Mongoose's auto-cast — see PHASE_11_NOTES.md
  for the real, reproduced bug this guards against (a raw string in such a
  filter can silently match nothing instead of erroring, in this project's
  Mongoose 8.9.5 setup). `findById`/`_id`-keyed filters are unaffected and
  left as-is, consistent with how the rest of this codebase already uses them.

## A real cross-phase regression found and fixed: `EventEmitter2` listener ceiling

Running the full `test:e2e` suite (specifically Phase 11's live-Redis
`notification-dispatch.e2e-spec.ts`, which boots the real `AppModule`)
failed with `app.init()` throwing a `TypeError` from deep inside
`eventemitter2`'s memory-leak-warning path. Root cause: `WORKFLOW_APPROVED_EVENT`
now has **11** `@OnEvent` listeners across the app (Customer, Loan, Group,
LoanProduct, FeeDefinition, Staff, ManualJournalEntry, RepaymentRecord,
EarlyLiquidation, and this phase's own two — `LeaveApplicationService`/
`SalaryService`) — one more than `EventEmitter2`'s default `maxListeners`
(10). This phase's own listeners were the ones that pushed the count over
the line; a real, reproducible regression, not a flaky test. Fixed by
raising `EventEmitterModule.forRoot({ maxListeners: 30 })` in `app.module.ts`
with headroom for future maintenance, not tuned to the exact current count.
This is exactly the kind of thing the brief's own suggested next step (a
full cross-module regression pass) is for — found here specifically
because Phase 11 built a real-AppModule-boot e2e test, which a purely
per-module unit suite would never have caught (no single module's own test
fixture wires up more than a handful of listeners on one event).

## ⚠️ A real, pre-existing infrastructure finding: the shared `.env`'s `PII_ENCRYPTION_KEY` is malformed

The boot smoke test (below) is the first script in this entire 12-phase
build to actually call `EncryptionService.encrypt`/`decrypt` against the
**real** `.env`'s `PII_ENCRYPTION_KEY` (every unit test across every phase
that touches BVN/NIN/salary encryption generates its own fresh, valid
random key per test run — see `randomBytes(32).toString('base64')` at the
top of every such spec file — so this was never exercised against the real
value until now). It failed immediately:

```
PII_ENCRYPTION_KEY must decode (base64) to exactly 32 bytes, got 47.
```

The real value (`9f4c2a7e1b8d6f03c5e9a1d7b4f82c6e0a3b9d5f1e7c4a8b2d6f0c9e1a7b3d5`)
is **not** valid base64-encoded 32 bytes (decodes to 47), and it also isn't
a valid 32-byte hex string either (63 characters — odd length, not even
valid hex at all, decodes to a truncated 31 bytes if hex-parsed). It looks
like a placeholder or copy-paste artifact that was never actually generated
via `openssl rand -base64 32` as this project's own `.env`/`.env.example`
comments instruct.

**Deliberately not fixed here.** Regenerating this key is easy, but if any
real BVN/NIN/salary ciphertext already exists in the shared Atlas dev
database from earlier phases' own boot smoke tests or manual testing,
rotating the key would make that data permanently, silently unreadable —
that's a real, hard-to-reverse consequence not appropriate to take
unilaterally. This smoke test instead overrode `PII_ENCRYPTION_KEY`
in-process only (never touching the real `.env` file) with a freshly
generated valid key, specifically to verify Phase 12's own encryption code
is correct in isolation from this pre-existing environment issue.

**Recommended next step, not taken here**: check whether any real
Customer/Staff document in the shared Atlas dev DB actually has a non-null
encrypted BVN/NIN field despite this key being broken (if the key has
always been broken, no such value could have ever round-tripped
successfully, so this is likely — but worth confirming directly) — if none
exist, regenerating `PII_ENCRYPTION_KEY` properly is a pure win with no
data-loss risk; if some do, they were presumably encrypted under a
*different*, since-overwritten valid key, and reconciling that needs to be
carefully coordinated, not this script's judgment call.

## A process lapse worth being honest about: overwrote pre-existing scaffolding without reading it first

`src/common/enums/hr.enums.ts` already existed (Phase 1 scaffold) — a
placeholder `LeaveType` enum (`ANNUAL`/`SICK`/`MATERNITY`/`PATERNITY`/
`COMPASSIONATE`/`UNPAID`/`OTHER`) with its own `TODO(business rule)`
comment flagging exactly the ambiguity this phase needed to resolve:
*"leave type taxonomy is not specified in the brief... confirm the real
list... before Phase 12 builds the leave application flow on top of this
schema."* Unlike every prior phase's own discipline of checking for and
reconciling with pre-existing Phase 1/2 scaffolding before writing, this
file was overwritten directly via a fresh `Write` (which doesn't require a
prior read the way `Edit` does) without first reading its content — a
genuine process lapse, caught only afterward via `git diff --cached`.

**The resulting content is, on inspection, still correct** — the brief's
own current schema sketch defines `LeaveType` as a real, dynamic,
admin-manageable Mongoose collection (`LeaveTypeService` CRUD), not a fixed
enum, which is a *better* resolution of the exact ambiguity the old TODO
flagged than picking any fixed taxonomy would have been (a coop can name
its own leave types rather than being stuck with a guessed default list).
The enum was fully superseded and correctly removed. `src/modules/hr/README.md`
(a harmless one-line Phase 1 placeholder note) was also found and removed
the same way, same as Phase 11's equivalent notifications README. Flagging
this transparently rather than presenting the outcome as if the file had
been properly checked first — the *result* held up, but the *process*
didn't, and that's worth surfacing on review.

## Notification integration — deliberately not wired, flagged as a known gap

Phase 11's own notes anticipated `NotificationTrigger.STAFF_ONBOARDING_OUTCOME`
and `ACCOUNT_DISABLED` would be "Phase 12/HR's job to wire." This phase's
brief, as given, does not describe any notification requirement for leave
or salary events (no "notify the applicant on approval," no "notify HR on
a new application") — so nothing here calls `NotificationPort`, and those
two pre-registered templates remain unconsumed. Not an oversight relative
to *this* brief, but flagged since an earlier phase's notes expected this
phase to close that loop and it doesn't.

## Deliverable

- `src/modules/hr/`: `LeaveType`/`LeaveBalance`/`LeaveApplication`/
  `SalaryRecord` schemas; `LeaveTypeService` (CRUD); `LeaveBalanceService`
  (lazy-created balances, idempotent transactional apply/reverse);
  `LeaveApplicationService` (dynamic chain selection, workflow.approved/
  rejected reactions, cancellation); `SalaryService` (encrypted, workflow-
  mediated, history-preserving); DTOs; `LeaveTypeController`/
  `HrLeaveController`/`HrSalaryController`; module — registered in
  `AppModule`, no other module needs to import anything from here.
- New RBAC capabilities: `HR_SALARY_MANAGE_CAPABILITY`,
  `LEAVE_CANCEL_APPROVED_CAPABILITY`, `HR_LEAVE_TYPES_MANAGE_CAPABILITY` —
  all ADMIN/SUPERADMIN only.
- New `WorkflowEntityType.SALARY_RECORD`; reused the pre-existing
  `LEAVE_APPLICATION` value (see above).
- The `EventEmitterModule` `maxListeners` fix (`app.module.ts`) — a genuine
  cross-phase regression, not new-module scope creep.
- Full test suite per the brief's required-tests list, green — **413 unit
  tests (31 new), 5 e2e tests**.

## Verification gates — all green

`tsc --noEmit` clean · `eslint` clean · `prettier --check` clean ·
`nest build` clean · full unit suite: **49 suites / 413 tests** ·
`test:e2e`: **2 suites / 5 tests** · `npm audit --omit=dev`: 0
vulnerabilities · boot smoke test (leave application → chain-selected
approval → balance application → cancellation-with-reversal; salary
propose → approve → supersede) run against the real Atlas dev DB and
deleted.

## This closes the 12-phase build

Per the brief's own closing note, the recommended next step is a full
end-to-end regression pass across all modules together, particularly
re-exercising the three cross-phase port rebindings this build accumulated:
`LoanStatusPort` (stubbed in Phase 6, rebound to `RealLoanStatusPort` in
Phase 8), `LedgerPostingPort` (stubbed in Phase 8/9, rebound to the real
accounting implementation in Phase 10), and `NotificationPort` (stubbed in
Phase 8/9, rebound to the real dispatch pipeline in Phase 11) — confirming
all three still resolve correctly together, in the same booted app, is
exactly the category of check that just caught the `EventEmitter2` ceiling
bug above, and is the natural next check now that every phase's own
module-level test suite is green in isolation.
