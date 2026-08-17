# Phase 8 Notes — Loans (application, verification, disbursement)

`src/modules/loans/`, `src/platform/integrations/rekognition/`, plus the
rebound `LOAN_STATUS_PORT` (`src/modules/groups/loan-status/real-loan-status.port.ts`).
**289 unit tests passing** (up from 262 — 27 new: 20 in
`loans.service.spec.ts` covering `LoansService`/`LoanVerificationService`
together, 5 in a dedicated `groups-loan-status-rebinding.spec.ts`, 2 new
`WorkflowEngineService.initiate` entityId tests), 1 e2e test, `npm audit
--omit=dev` → 0 vulnerabilities. Full build/lint/format/typecheck clean, plus
a boot smoke test confirming the compiled app boots and a full raise →
approve → verify (×N) → disburse flow works end-to-end, including a
deliberately under-funded branch correctly blocking (and later, once funded,
completing) disbursement.

## 0. A pre-existing bug found and fixed while building this phase

`BranchFundBalanceService` (Phase 4) passed `branchId` as a **plain string**
into every query filter (`credit`/`debit`/`getBalance`) and into
`handleBranchCreated`'s `$setOnInsert` write. This is the exact same family
of bug already documented twice in this codebase — `KycRecord.customerId`'s
query-side cast failure (Phase 5) and the write-side `Model.create()` cast
failure (Phase 6) — now found on the *query* side of a *different* schema's
non-`_id` ObjectId field. It went completely undetected by Phase 4's own
tests only by coincidence: `handleBranchCreated`'s `$setOnInsert` stored the
uncast string too, so every read/write in that one self-contained flow used
strings consistently and happened to match. The moment Phase 8's disbursement
transaction needed to `debit()` a balance document created with a genuine
`Types.ObjectId` `branchId` (as any other code path would produce), the query
silently matched nothing — every disbursement failed with a **false**
`InsufficientBranchFundsException`, regardless of actual balance.

Reproduced empirically (not guessed) by isolating `findOne({branchId: <string>})`
returning `null` against a document that plainly existed, versus
`findOne({branchId: new Types.ObjectId(branchId)})` finding it instantly — see
the debugging trail in the commit history if useful. Fixed all four methods
in `branch-fund-balance.service.ts` with explicit `new Types.ObjectId(...)`
casts, and fixed the one place `branch-fund-balance.service.spec.ts` itself
queried with a plain string. All of Phase 4's own tests
(`branch-fund-balance.service.spec.ts`, `branch-funding.service.spec.ts`)
still pass after the fix — they only ever exercised the self-consistent
all-string path, which is unaffected. Unlike Phase 6's Staff/Customer
`.create()` near-miss (where the team explicitly declined to "fix" code
without proof the bug applied there), this one **is** proven — direct
reproduction, not a pattern-matched guess.

## 1. All-or-nothing group disbursement — confirmed as built

Built exactly as the brief's own stated default: every member's
`DisbursementVerification` must reach `PASSED` before *any* member's portion
disburses (`LoanVerificationService.checkAndDisburse`/`disburse`), and the
branch fund debit happens once for the full `cumulativeAmountKobo`
(`BranchFundBalanceService.debit`, inside the same Mongo transaction as every
per-member schedule write and ledger-posting call). Tested explicitly: 2-of-3
members passed does not touch the branch balance or generate any schedule
(`checkAndDisburse` — "does not trigger..."); an `InsufficientBranchFundsException`
partway through leaves **zero** members with a schedule/active status and the
branch balance completely untouched (`disbursement transaction` — "all-or-
nothing..."), with a follow-up assertion that a later manual
`checkAndDisburse` retry succeeds once the branch is topped up.
**Confirm before relying on this** — the staggered per-member alternative was
deliberately not built (meaningfully more complex fund-debit/ledger-posting
transaction boundaries), per the brief's own framing of this as a real
business-risk decision, not a minor implementation detail.

## 2. Pre-loan fee gating — resolved to surfacing-only, per your explicit default

`FeePaymentsService.getOutstandingPreLoanFees` computes every outstanding
`PRE_LOAN` fee per member and `LoansService.raiseApplication` returns it
(`RaiseApplicationResult.outstandingPreLoanFees`) — but never blocks the
raise. `FeePayment` itself is deliberately minimal and **not**
workflow-mediated: `FeePaymentsService.recordPayment` is a direct,
upserting write, gated by the same new `LOAN_DISBURSEMENT_OPS_CAPABILITY` as
the other Phase 8 operational actions (front-desk cash collection, not a
maker-checker decision — see §7). The open question from the brief — whether
`PRE_LOAN` fees should really be collected at customer/group onboarding
(Phases 5/6, not retrofitted) or gated immediately before `raiseApplication`
— is **still open**; this phase deliberately builds neither enforcement path,
only the surfacing mechanism, exactly as instructed. A `PERCENTAGE` fee whose
`percentageOf` isn't `PRINCIPAL` can't be pre-computed before a loan exists
(no `OUTSTANDING`/`OVERDUE_AMOUNT` yet) — surfaced with `amountKobo: null` in
that case rather than guessing or omitting the fee entirely.

## 3. Loan-raised notification — both figures sent, not a guessed single one

`NotificationPort.sendLoanRaisedNotification(customerId, memberAmountKobo,
groupCumulativeAmountKobo, raisedAt)` — the brief's "amount and date" wording
doesn't disambiguate which amount it means, so `LoansService.raiseApplication`
passes **both** for every member notification rather than guessing one. This
is the resolved, final approach (not still open) — flagged here per the
brief's own instruction to record which figure was chosen.

## 4. `entityId`-carrying workflow initiation — worked, but required a Phase 2 engine adjustment

Confirmed: `Loan`/`MemberLoanAccount` are created **immediately** in
`raiseApplication`, not deferred until approval — same deviation category as
Phase 5's `Customer` (needed here because the immediate "loan raised"
notification requires something concrete to notify about, and a concrete
`entityId` to hand the workflow engine at initiation). This is the first
phase to actually pass a pre-existing entity id into `initiate()`.

**The Phase 2 engine did need adjustment**: `WorkflowEngineService.initiate`
previously hardcoded `entityId: null` on every new `WorkflowRequest`, with no
parameter to override it — every prior caller (Staff/Customer/Group/
LoanProduct/FeeDefinition) creates its entity only on approval and backfills
via the separate `linkEntity` call. Added an optional `entityId?: string |
null` to `InitiateWorkflowInput`, defaulting to `null` when omitted (`input.entityId
?? null`) — a minimal, additive, backward-compatible change; every existing
caller is unaffected (still gets `null`, still uses `linkEntity`). Directly
tested in `workflow-engine.service.spec.ts` (both "accepts a pre-existing
entityId" and "still defaults to null when omitted"), and exercised
end-to-end in `loans.service.spec.ts` ("the workflow request carries the
pre-existing loan._id as entityId and uses the dynamically-registered
LOAN/APPROVE_&lt;productId&gt; chain"). Works cleanly — no further engine changes
needed.

## 5. `LEDGER_POSTING_PORT` (Phase 10) / `NOTIFICATION_PORT` (Phase 11) — both temporary, both flagged loudly

Same pattern as Phase 6's `LoanStatusPort`. `LEDGER_POSTING_PORT` is bound to
`StubLedgerPostingPort`, which only logs each call — **no journal entry is
ever posted**. Phase 10 (Accounting) must replace this binding in
`loans.module.ts`, and per the brief, is expected to re-derive every
historical disbursement/fee-collection directly from
Loan/MemberLoanAccount/FeePayment (the source of truth already exists there)
rather than needing a ledger-specific backlog table.

`NOTIFICATION_PORT` is bound to `PendingNotificationLogPort`, which writes
every call (`sendLoanRaisedNotification`/`sendVerificationEscalation`/
`sendDisbursementCompleted`) to a new `PendingNotificationLog` collection
(`{type, recipientCustomerId, payload, createdAt, dispatched: false}`) rather
than a silent no-op — per the brief's explicit instruction. **Phase 11 must
drain this backlog** (`{dispatched: false}`) when it wires up the real
Brevo/Termii queue, not assume a clean slate — documented on the schema
itself (`modules/notifications/schemas/pending-notification-log.schema.ts`,
placed in the not-yet-built notifications module since that's the domain
that owns it, even though only Phase 8 writes to it today — same
cross-module-schema-ownership reasoning as Phase 3's established convention)
and in that module's `README.md`.

A third, **unassigned** port was also added, not requested by name in the
port list but required by §6's disbursement flow: `BANK_TRANSFER_PORT`
(`StubBankTransferPort`, log-only) for the TRANSFER-channel disbursement
step. No bank-transfer provider has been chosen yet and no phase is
currently assigned to rebind it — flagged as a genuine open item, same as
the brief's own "flag clearly that this needs a real provider decision" note.

## 6. `LOAN_STATUS_PORT` rebound — `RealLoanStatusPort`, with a circular-dependency avoidance worth noting

`groups.module.ts` now binds `LOAN_STATUS_PORT` to `RealLoanStatusPort`
(`groups/loan-status/real-loan-status.port.ts`), which runs exactly the
query given in the brief against `MemberLoanAccount.status`. `StubLoanStatusPort`
is left in the codebase (its own doc comment updated to say so) only as a
lightweight option for tests that don't need real loan data.

**Non-obvious design choice**: `RealLoanStatusPort` lives inside `modules/groups/`,
not `modules/loans/`, even though it reads Loans' data. `LoansModule` needs
`GroupsService` (for `isEligibleForLoanApplication`/`getActiveMembers`), so
`GroupsModule` importing `LoansModule` back would be circular. Instead,
`GroupsModule` imports only the `MemberLoanAccount` **schema** (raw model
registration, the same "cross-module existence checks via a raw injected
model" pattern already established for Branch/Customer in this same module)
and `RealLoanStatusPort` is defined and injected within `groups/`, using that
raw model directly — no module-to-module import cycle anywhere. Proven
end-to-end (not just as a port-in-isolation unit test, per the brief's own
instruction) in the new `groups-loan-status-rebinding.spec.ts`: creates real
`MemberLoanAccount` documents at `PENDING`/`ACTIVE`/`CLOSED`/`DEFAULTED` and
drives `GroupsService.initiateMemberRemoval` through the real wiring,
confirming PENDING/ACTIVE block and CLOSED/DEFAULTED/no-account-at-all allow.

## 7. New flat capability: `LOAN_DISBURSEMENT_OPS_CAPABILITY`

None of `initiateMemberVerification`/a manual `checkAndDisburse` retry/
`confirmChequeHandover`/`FeePaymentsService.recordPayment` are maker-checker
proposals awaiting a second approver — they're operational facts being
recorded (a verification outcome, a cheque handover, a fee payment), so a
`workflow:*` capability doesn't fit any of the three step conventions. Added
one new flat capability, `loan:disbursement_ops`, granted by default to the
same roles that can raise a loan (MARKETER/MANAGER/ADMIN/SUPERADMIN — see
`default-role-capabilities.ts`). `resolveEscalation` deliberately uses
`approveCapability(LOAN)` instead (Admin/SuperAdmin/Approver only) — a
meaningful compliance/rejection decision, not routine front-desk work, per
the brief's explicit "Admin/Approver capability required."

Adding this flat capability to MARKETER's default seed required updating one
existing Phase 2/3 test (`rbac.service.spec.ts`'s "gives MARKETER no review
or approve capability, only initiate") — its assertion was stricter than its
own stated intent (it meant "never review/approve," not literally "every
capability starts with workflow:initiate:"); narrowed to check specifically
for the absence of `workflow:review:`/`workflow:approve:` capabilities,
which is what it always meant to test.

## 8. `disbursementChannel` moved into `raiseApplication`'s per-member input — a schema/signature gap, resolved

The brief's `raiseApplication` signature takes `memberLoanRequests: {
customerId, requestedAmountKobo }[]`, but `MemberLoanAccount.disbursementChannel`
is a required schema field with no default, and nothing in §5/§6 ever
supplies it for the first time — by the time verification/disbursement read
it, it has to already exist. Resolved by adding `disbursementChannel` as a
third, required field on each member's request DTO
(`MemberLoanRequestDto`) — a member chooses their disbursement channel when
applying, which is also the most natural real-world reading (a mobile
self-service applicant picks TRANSFER; an officer filling in a form for a
cheque-pickup applicant picks CHEQUE_PICKUP). Flagged rather than silently
defaulting every member to `TRANSFER`.

## 9. Schedule normalization — Phase 7's two shapes unified into one persisted shape

`calculateFlatInterestSchedule`/`calculateReducingBalanceSchedule` return
slightly different installment shapes (FLAT has no opening/closing balance;
REDUCING has both). `LoanVerificationService.normalizeSchedule` derives
opening/closing balance for FLAT too (trivially, by tracking cumulative
principal paid down) so `MemberLoanAccount.schedule` has one consistent
shape for Phase 9 regardless of `interestType` — it never re-derives
principal/interest amounts themselves, only adds balance bookkeeping around
Phase 7's already-correct numbers. Directly tested against
`calculateFlatInterestSchedule`'s own output (`disbursement transaction` —
"repayment schedules... match... exactly") to prove this phase never
reimplements that math.

## 10. Smaller flagged decisions

- **`officeId` == `Branch`**: `DisbursementVerification.officeId` refs
  `Branch` — no separate "Office" entity exists anywhere in this codebase.
  Flag/confirm if "office" was meant to be something more specific than a
  branch.
- **BVN `providerRef`/Rekognition `rekognitionRef`**: `BvnVerificationAdapter`'s
  public contract exposes no natural provider transaction reference to carry
  into `DisbursementVerification.bvnRecheck.providerRef`, so it's a locally
  generated correlation id (`randomUUID()`), not something the provider
  returned. `rekognitionRef` is likewise locally generated — AWS's
  `CompareFacesCommand` response has no natural single "reference" field
  either. Both are still real, useful correlation ids for tracing back to
  `BvnCallLog`/`FaceComparisonCallLog`, just not provider-issued ones.
- **Live image retention**: never persisted anywhere — `FaceComparisonAdapter.compareFaces`
  passes `targetImageBuffer` straight to AWS as raw bytes and never writes it
  to Mongo or S3; nothing in this phase's code path stores it, so it's
  discarded by default once the call returns, per the brief's own default.
  Flagged as a retention-policy question worth an explicit confirmation
  either way, per the brief.
- **`resolveEscalation`'s resolved-but-still-ESCALATED status**: an
  `OVERRIDE_PASS`'d verification transitions `status` to `PASSED` (so
  `checkAndDisburse` can proceed), but a `REJECT_LOAN`'d verification stays
  at `ESCALATED` — `resolvedBy`/`resolvedAt`/`resolutionNote` (additive
  fields beyond the brief's literal schema) are the "this was handled"
  marker, rather than inventing a new terminal status value.
- **`VerificationContext` extended exactly as its own Phase 1/2 comment
  anticipated** (`PRE_DISBURSEMENT`, `CHEQUE_PICKUP`) — reused for
  `CustomerService.recordBvnDirectVerifyForContext`'s live BVN recheck,
  chosen by `MemberLoanAccount.disbursementChannel` so the KYC audit trail
  can distinguish which channel a recheck happened under.
- **`AWS_REKOGNITION_USE_MOCK`**: added to mirror `AWS_S3_USE_MOCK`'s
  existing convention (mock forced when AWS credentials are absent, same
  credentials pair as S3) — `aws.rekognition.faceMatchThreshold` already
  existed from Phase 1/2 scaffolding and is reused as-is, not renamed to the
  brief's suggested `REKOGNITION_MATCH_THRESHOLD`.
- **Stale Phase 1/2 placeholder superseded**: `src/common/enums/loan.enums.ts`
  already existed, unused anywhere (confirmed by grep), with a materially
  different shape (a `LoanStatus` with `VERIFICATION_PENDING`/
  `DISBURSEMENT_PENDING`/`ACTIVE`, separate `PreDisbursementVerificationStatus`
  and `ChequePickupVerificationStatus` types modeling two verification
  concepts instead of one `DisbursementVerification` with a `channel` field).
  Replaced outright to match this phase's actual spec — same "surface what
  you find, don't silently overwrite" handling as every prior phase's
  placeholder discoveries. `LoanStatus.VERIFICATION_FAILED` and
  `DisbursementVerificationStatus.FAILED` are both kept (present in the
  brief's own literal type unions) but are currently **unreachable** by any
  code path — the brief's explicit "do not automatically fail the whole
  loan" instruction means a failing check always routes to `ESCALATED`
  instead, never a dead-end FAILED/VERIFICATION_FAILED state.
- **Test file organization**: `LoansService` and `LoanVerificationService`
  tests live together in one `loans.service.spec.ts` rather than two
  separate files, deviating from the project's usual one-file-per-service
  convention — justified by how much of their dependency graph and fixture
  setup (branch/group/customer/product/fee fixtures, the full raise→approve→
  verify→disburse pipeline) is shared between them; splitting would mean
  duplicating most of the ~250-line setup block.

## Deliverable

- `src/modules/loans/`: `Loan`/`MemberLoanAccount`/`DisbursementVerification`/
  `FeePayment` schemas; `LoansService` (raise, workflow approve/reject
  handling, reads); `LoanVerificationService` (per-member verification,
  escalation resolution, check-and-disburse, the disbursement transaction,
  cheque handover); `FeePaymentsService`; DTOs; controllers; module.
- `src/platform/integrations/rekognition/`: `FaceComparisonAdapter`
  interface, real (AWS SDK `CompareFacesCommand`, S3-key source image,
  raw-bytes target image) + mock adapters, `FaceComparisonCallLog`.
- Rebound `LOAN_STATUS_PORT` (`RealLoanStatusPort`), proven end-to-end.
- `LEDGER_POSTING_PORT`/`NOTIFICATION_PORT`/`BANK_TRANSFER_PORT` — all
  temporary stubs, all loudly flagged for their (or an as-yet-unassigned)
  future rebinding phase.
- `WorkflowEngineService.initiate`'s new optional `entityId` parameter.
- `BranchFundBalanceService`'s query-cast bug fix (§0).
- Full test suite per the brief's required-tests list, green.

Do not start Phase 9 (Repayments) until this is reviewed — Phase 9 reads and
writes `MemberLoanAccount.outstandingBalanceKobo` directly and needs this
phase's disbursement transaction correctness proven first, which it now is
(§1, §9).
