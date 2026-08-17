# Phase 9 Notes — Repayments (recording, disputes, penalties, early liquidation)

`src/modules/repayments/`. **317 unit tests passing** (up from 289 — 28 new:
12 `RepaymentsService`, 4 `EarlyLiquidationService`, 9 `PenaltySweepService`,
3 penalty-calculation retrofit tests replacing/extending Phase 7's), 1 e2e
test, `npm audit --omit=dev` → 0 vulnerabilities. Full build/lint/format/
typecheck clean, plus a boot smoke test confirming the compiled app runs a
full record → approve → penalty-sweep(recurring, compounding) → early-
liquidation → complete flow end-to-end.

## Confirmed assumptions (from the brief's own flagged list)

**Repayment approval chain — two-step, confirmed.** `REPAYMENT_RECORD/RECORD`
registers Reviewer→Approver, consistent with Group/Customer. Not a guess:
`WorkflowEntityType.REPAYMENT_RECORD` was already in `MAKER_ENTITY_TYPES`
(Phase 2), so MANAGER already held `reviewCapability(REPAYMENT_RECORD)` and
ADMIN/SUPERADMIN/APPROVER already held `approveCapability(REPAYMENT_RECORD)`
via `ALL_WORKFLOW_ENTITY_TYPES` — the exact same kind of pre-existing,
unused-until-now infrastructure that confirmed Phase 6's Group/Customer
correction. No RBAC changes were needed for this chain at all.

**Overpayment handling — confirmed as built.** Caps the decrement at the
current outstanding balance; the excess is recorded as
`RepaymentRecord.overpaymentAmountKobo` plus a dedicated
`REPAYMENT_OVERPAYMENT_FLAGGED` audit entry. Never a negative balance, never
an automatic refund. **Confirm this matches the coop's actual policy** — per
the brief's own framing, this is a policy default, not a technical
certainty.

**Early liquidation — workflow-mediated, single-step, confirmed distinct
from ordinary repayment recording.** One nuance worth flagging: the brief
says "Admin/Manager approval," but the single step's `requiredCapability` is
`approveCapability(EARLY_LIQUIDATION)` — held by ADMIN/SUPERADMIN/APPROVER,
**not** MANAGER, because MANAGER never holds an approve-capability anywhere
else in this codebase's established model (only review). Resolved to the
established convention rather than introducing a MANAGER-can-approve
exception found nowhere else in the system — **confirm** if MANAGER was
actually meant to approve this directly.

## Liquidation-delay-charge grace window — resolved (genuinely open question)

The brief explicitly flagged this as undecided. Resolved to: **no separate
grace period** — `EarlyLiquidationRequest.approvedAt` is day zero, and delay
charges can start accruing from day 1 of non-payment (the approval day
itself, day 0, never charges). Implemented with the same `daysLate -
gracePeriodDays` shape the penalty sweep uses, with an effective grace of 0:
`periodIndex = floor((daysSinceApproval - 1) / recurrenceIntervalDays)`,
gated by `daysSinceApproval >= 1`. **Confirm** — this is a real policy
choice, not a technical default; a coop that wants, say, a 3-day liquidation
grace window would need this changed (a one-constant change, not a
redesign).

## `LedgerPostingPort` — full method list now awaiting Phase 10

Every method is still the Phase 8/9 log-only `StubLedgerPostingPort`. Phase
10 (Accounting) must implement **all four**, not just the two added this
phase:

- `postDisbursement(loanId, memberLoanAccountId, amountKobo, session)` — Phase 8
- `postFeeCollection(feePaymentId, amountKobo, session)` — Phase 8
- `postRepayment(repaymentId, amountKobo, session)` — **new, Phase 9**
- `postPenalty(penaltyChargeId, amountKobo, session)` — **new, Phase 9**,
  reused for BOTH an overdue-installment penalty charge and an
  early-liquidation recurring delay charge (a delay charge is functionally a
  penalty, just scoped to a liquidation request instead of a schedule
  installment — see `PenaltySweepService`, deliberately not a fifth
  near-duplicate method).

`NOTIFICATION_PORT` also gained one new method this phase —
`sendPenaltyCharged(customerId, amountKobo, context)`, reused identically
for both charge types — still bound to `PendingNotificationLogPort`,
still Phase 11's responsibility to drain.

## The FIFO reconciliation — a design decision the schema itself required

The brief's sweep pseudocode says "walks the schedule to find installments
past due date with unpaid amounts outstanding," but `MemberLoanAccount` only
tracks a single aggregate `outstandingBalanceKobo` — nothing allocates a
given repayment to a specific installment. Without *some* reconciliation, an
account that's been paid down substantially via lump-sum repayments (not
strictly aligned to the schedule) would keep getting penalized against old
installments that are, in aggregate, already covered.

Resolved with a FIFO cumulative-balance comparison, computed once per
account per sweep: `amountPaidTowardScheduleKobo = totalOriginalScheduledKobo
+ totalPenaltiesChargedKobo - outstandingBalanceKobo` (netting out every
penalty ever charged, so a penalty charge — which *increases*
`outstandingBalanceKobo` — never gets misread as "the customer paid less
than they did"). An installment is walked as "unpaid" if the running
cumulative `totalDue` up to and including it exceeds this figure. This is
the standard way to derive "which installment is currently due" from a
single running balance against a fixed amortization schedule — not
over-engineering, but flagged since the brief doesn't spell it out.

For the penalty *amount* itself, `overdueAmountKobo` is the installment's
full `totalDue`, not this reconciled remaining-unpaid portion — the brief's
own pseudocode comment ("or the still-unpaid portion of it") flags this
exact ambiguity itself; resolved to the simpler, literal reading.

## Two retrofits to already-shipped Phase 7 code — both required, both flagged

**1. `PenaltyPercentageBasis` gained back `PRINCIPAL`.** Phase 7 explicitly
excluded it ("never PRINCIPAL — a loan already exists by the time a penalty
applies"), which was correct for a *single* penalty application but didn't
anticipate recurring charges. Phase 9's brief requires PRINCIPAL as the
non-compounding recurring basis (charged against the fixed original
principal, never the growing balance) — directly tested
(`compounds for OUTSTANDING basis... but stays flat for PRINCIPAL basis`).
Reversing a documented Phase 7 design decision is exactly the kind of thing
this project's discipline says to flag loudly rather than silently change —
done here, in both the enum's own doc comment and this file.

**2. `calculatePenaltyAmount`'s signature changed** from `(penaltyRule,
overdueAmountKobo: number, daysLate)` to `(penaltyRule, context:
PenaltyCalculationContext, daysLate)`, mirroring `calculateFeeAmount`'s
existing context-object pattern. Phase 7's version explicitly declined to
fork on `percentageOf`, trusting the caller to pass the one right amount;
Phase 9 needs the function itself to select between PRINCIPAL/OUTSTANDING/
OVERDUE_AMOUNT per period, since the sweep computes all three context values
every time. `penalty-calculation.spec.ts` was rewritten (not just extended)
to match — all prior test cases preserved with the new call shape, three new
PRINCIPAL-basis cases added. One deliberate behavior simplification that
came along with this: the old signature unconditionally validated
`overdueAmountKobo >= 0` even for a FIXED-calcType rule that never uses it;
the new version only validates whatever context field it actually reads
(same discipline `calculateFeeAmount` already uses) — a FIXED penalty no
longer throws on a negative/malformed context it never touches.

Also retrofitted (additive, not a behavior change): `LoanProduct.penaltyRule`
and `FeeDefinition` both gained `frequency`/`recurrenceIntervalDays`/
`maxRecurrences` fields — Phase 7 only ever built `ONE_TIME` behavior with no
field to express it. Defaults to `ONE_TIME` everywhere, so every
already-shipped shape (schema-wise; nothing was ever actually deployed)
behaves unchanged. `FeeDefinition.frequency` is meaningful today only for an
EARLY_LIQUIDATION-category fee, but validated uniformly across every
category so a malformed RECURRING config can never be saved regardless.

## One retrofit to already-shipped Phase 8 code

`RepaymentScheduleEntry` gained a `dueDate: Date` field — Phase 8 explicitly
flagged this as deferred ("not computed... Phase 9 or later may set actual
due dates"), since Phase 8 had no consumer that needed a real calendar date.
Phase 9's penalty sweep is that consumer. Computed once, at disbursement
time, via a new `addMonths` utility (`common/date/add-months.util.ts`) that
clamps to the last day of the target month (Jan 31 + 1 month = Feb 28/29,
not a rollover into March) rather than relying on naive `Date.setMonth`
arithmetic.

## BullMQ — sweep logic tested directly, the queue wiring is not

`PenaltySweepService.runDailySweep` contains 100% of the sweep's decision
logic and takes an explicit `referenceDate` parameter specifically so tests
can control "how many days late" deterministically without waiting on real
time. `PenaltySweepProcessor` (`@Processor('penalty-sweep')`) is a thin
wrapper that only (a) registers a daily repeatable job via
`Queue.upsertJobScheduler` on boot and (b) calls `runDailySweep()` when a job
fires — this class itself is not unit-tested, since doing so would require a
live Redis connection, which this project's established `npm test`
convention has never depended on (a real local Redis happens to be available
in this dev environment, confirmed and used for the boot smoke test, but the
committed test suite doesn't assume one exists). This mirrors Phase 8's
`checkAndDisburse` being tested by direct call, never through HTTP.

## Smaller flagged decisions

- **`RepaymentRecord`/`EarlyLiquidationRequest` created immediately**, not
  deferred to approval — same deviation category as Phase 8's `Loan`,
  documented on each schema. A repayment record is evidence of a real-world
  event already attested to; an early-liquidation request needs a locked-in
  fee/balance snapshot that can't wait for approval to exist.
- **A reversed dispute that had closed the account reopens it to ACTIVE.**
  Not explicitly specified — the natural symmetric counterpart of "balance
  reaching 0 closes the account," implemented and tested
  (`a dispute that reverses a CLOSED account reopens it to ACTIVE`).
- **A completing liquidation payment may also set
  `overpaymentAmountKobo`** as a side effect of reusing `applyToBalance`
  unmodified for liquidation-linked repayments (rather than special-casing
  the balance-application path by linkage) — harmless, since
  `EarlyLiquidationService.checkCompletion` runs afterward and is
  authoritative once the full amount clears, but flagged since the field
  name ("overpayment") is a slight misnomer in this one case (it's really
  the liquidation fee being paid on top of the ordinary balance).
- **"Cancel all remaining unpaid schedule entries"** (on liquidation
  completion) is embodied by zeroing `outstandingBalanceKobo` and setting
  the account `CLOSED` — individual `RepaymentScheduleEntry` rows carry no
  cancellation flag in this schema (not specified by the brief) and are left
  as an untouched historical record.
- **Proof-of-payment upload** (`RepaymentRecord.proofOfPaymentImageKey`) was
  built as a simple, separate `POST /repayments/:id/proof` endpoint (S3
  upload, same pattern as Phase 5's biometric capture) — attachable at any
  point, not gated by status, and not deeply tested beyond basic coverage
  since it's outside the brief's required-tests list.
- **`linkRepaymentToLiquidation` only accepts a `PENDING` repayment** — a
  deliberate guard (not specified by the brief) preventing a repayment from
  being linked *after* its own approval already applied it as an ordinary,
  un-linked repayment, which would leave `checkCompletion` never triggered
  for it.
- **Event-driven decoupling**: `EarlyLiquidationService` reacts to
  `RepaymentsService.applyToBalance` via a new internal
  `REPAYMENT_APPLIED_EVENT` (`modules/repayments/events/repayments.events.ts`)
  rather than a direct method call — `RepaymentsService` never needs to know
  `EarlyLiquidationService` exists, same principle as every domain module
  independently listening to the workflow engine's own events.

## Deliverable

- `src/modules/repayments/`: `RepaymentRecord`/`PenaltyCharge`/
  `EarlyLiquidationRequest`/`LiquidationDelayCharge` schemas;
  `RepaymentsService` (recording, workflow approve/reject, disputes, the
  idempotent apply/reverse-balance core); `EarlyLiquidationService`
  (initiate/approve, linking, completion); `PenaltySweepService` (the daily
  sweep's full logic) + `PenaltySweepProcessor`/`penalty-sweep.queue.ts`
  (thin BullMQ wrapper); DTOs; controllers; module.
- Retrofits: `PenaltyPercentageBasis.PRINCIPAL`,
  `calculatePenaltyAmount`'s context-object signature,
  `LoanProduct.penaltyRule`/`FeeDefinition`'s frequency fields (Phase 7);
  `RepaymentScheduleEntry.dueDate` (Phase 8).
- `LedgerPostingPort.postRepayment`/`postPenalty`,
  `NotificationPort.sendPenaltyCharged` — all still stubs, full list above.
- Full test suite per the brief's required-tests list, green, including the
  compounding-vs-flat behavioral test and every idempotency-under-repeated-
  execution test (balance application, both penalty sweep modes, liquidation
  delay accrual) called out as this phase's load-bearing correctness
  guarantees.

Do not start Phase 10 (Accounting) until this is reviewed — Phase 10
implements every `LedgerPostingPort` method accumulated across Phases 8 and
9 (four total, listed above) and needs this final method list settled first,
which it now is.
