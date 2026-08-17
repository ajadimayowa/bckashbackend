# Phase 10 Notes — Accounting (chart of accounts, double-entry ledger, `LedgerPostingPort` reconciliation)

`src/modules/accounting/`. **344 unit tests passing** (up from 317 — 27 new,
all in `src/modules/accounting/`), 1 e2e test, `npm audit --omit=dev` → 0
vulnerabilities. Full typecheck/lint/format/build clean. Boot smoke test run
and deleted per convention (automated postings via a real disburse →
repay → penalty-sweep flow, plus a manual entry propose → approve → post
flow — see "Boot smoke test" below).

## The `LedgerPostingPort` reconciliation — finalized to the brief's exact shape

`src/modules/loans/interfaces/ledger-posting-port.interface.ts` now matches
the brief's sketch exactly: four methods, each taking a single params object
(no more positional args), an optional `session?: ClientSession`, and
returning `Promise<PostedJournalEntry>` (never `void`) — the posted entry, or
the pre-existing one on an idempotent no-op. `postPenalty` takes an explicit
`sourceEntityType: 'PENALTY_CHARGE' | 'LIQUIDATION_DELAY_CHARGE'`, resolving
the ambiguity Phase 9 flagged (both charge types shared one method with no
way to tell them apart).

Phase 8/9 call sites were adjusted to the new shape (`branchId` added,
`sourceEntityType` made explicit):

- `loan-verification.service.ts` (`postDisbursement`, Phase 8)
- `repayments.service.ts` (`postRepayment`, Phase 9)
- `penalty-sweep.service.ts` (`postPenalty` ×2 — `PENALTY_CHARGE` and
  `LIQUIDATION_DELAY_CHARGE`, Phase 9)
- `fee-payments.service.ts` (`postFeeCollection`, Phase 8 — **see the gap
  below, this call site didn't actually exist until this phase**)

`StubLedgerPostingPort` was rewritten to the new signature and is now
**test-only** — `LoansModule` rebinds `LEDGER_POSTING_PORT` to the real
`LedgerPostingService` via `useExisting`; the stub only remains bound in
`loans.service.spec.ts` and `repayments-test-context.ts`'s own isolated test
modules. Grep confirmation, run after all fixes below (see "Grep evidence"
section) — every production call site now resolves to a real posting.

## Gap discovered and fixed: `postFeeCollection` was never actually called

Per the brief's own "grep for any remaining stub usage" instruction, applied
proactively before writing anything new: `FeePaymentsService.recordPayment`
(Phase 8) never called `ledgerPostingPort.postFeeCollection` anywhere — the
call site simply didn't exist, not a stub sitting unused. Fixed by:

- Adding `branchId: Types.ObjectId` to the `FeePayment` schema, resolved via
  the paying customer's own `branchId` at record time (no existing field
  carried it).
- Calling `postFeeCollection` only when `status === FeePaymentStatus.PAID` —
  never for `WAIVED`, since no money moved.

This required injecting the `Customer` model directly into
`FeePaymentsService` (cross-module raw model injection, same established
pattern as `RepaymentsService`'s own Branch/Customer injection) purely to
resolve `branchId`.

## The load-bearing correctness property: idempotent posting

`sourceRef = "{sourceEntityType}:{sourceEntityId}"` (automated) or
`"MANUAL:{workflowRequestId}"` (manual), enforced by a unique index on
`JournalEntry.sourceRef`. All four public `LedgerPostingService` methods
delegate to one shared private helper, `postIdempotent`: pre-check by
`sourceRef`, return the existing entry if found; otherwise insert, catching a
duplicate-key error (code `11000`) from a lost race and re-fetching/returning
the winner rather than propagating failure. Tested directly: two identical
sequential calls return the same entry with only one document persisted
(idempotency), and `Promise.all` of two/five *simultaneous* identical calls
still produces exactly one document (concurrency — the unique-index
fallback actually firing, not just the pre-check succeeding by luck).

`postPenalty`'s two source types are distinguished at the `sourceRef` level
(`PENALTY_CHARGE:<id>` vs `LIQUIDATION_DELAY_CHARGE:<id>`) while
`JournalEntry.sourceEntityType` stays the fixed `PENALTY` category for both —
tested with a contrived shared underlying id to prove the distinction lives
in the prefix, not merely in near-certainly-unique ObjectId bytes.

## Architectural finding — session non-nesting, and a real deadlock it caused

**Decision (documented in the interface's own doc comment):**
`LedgerPostingService.postIdempotent` runs its own independently-managed
session/transaction for every posting, and does **not** use the caller-
supplied `session` parameter for the write itself (kept in the signature
purely for interface-shape fidelity to the brief). Reason: MongoDB aborts an
entire multi-document transaction on its first write error, and a session in
that aborted state cannot perform *any* further operation — not even a plain
read. That makes "catch a duplicate-key error and gracefully re-fetch/return
the winner" fundamentally incompatible with reusing a caller's own
externally-managed transaction for the insert. Trade-off accepted: a
vanishingly rare crash-between-two-independent-commits window, in exchange
for the idempotency guarantee actually working as specified.

**This decision has a consequence the initial implementation missed, and it
produced a real, reproducible bug, not just a theoretical risk.** Every
original Phase 8/9 call site invoked `postDisbursement`/`postRepayment`/
`postPenalty` from **inside** its own caller's still-open
`session.withTransaction(...)` block, passing that session along (even
though `LedgerPostingService` ignores it). That means, mid-transaction, the
caller was synchronously awaiting `LedgerPostingService.postIdempotent`
opening a **second, independent** session and transaction on the *same*
underlying connection while the first transaction was still uncommitted.

Running the full test suite (`--runInBand`) surfaced this as a genuine hang:
`penalty-sweep.service.spec.ts`'s idempotency test reported "Exceeded timeout
of 30000 ms" but had actually run for **570 seconds** before Jest could even
report the failure — the classic signature of a real deadlock (the promise
never resolves; Jest's timeout only detects it, it doesn't unstick it), not
ordinary slowness. Isolated runs of the accounting suite alone were clean
(no caller ever wraps a transaction around it there), which is exactly why
this didn't surface until the nested-transaction call sites were exercised.

**Fix:** relocated all four real production call sites to run **after** their
enclosing transaction commits, not inside it:

- `loan-verification.service.ts::disburse` — `postDisbursement` moved out of
  the transaction loop into a new post-commit loop (per member account,
  alongside the pre-existing post-commit notification/transfer loop).
- `repayments.service.ts::applyToBalance` — `postRepayment` moved to after
  `session.endSession()`, gated on the same `applied` flag that already
  distinguished a real balance-decrement from an idempotent no-op.
- `penalty-sweep.service.ts::applyPenaltyCharge` /
  `applyLiquidationDelayCharge` — same pattern, gated on `applied` +
  the newly-created charge document's id captured during the transaction.

This changes **nothing** about the atomicity guarantee — the ledger write
was never actually atomic with the caller's transaction to begin with (it
runs in its own separate, already-independent transaction regardless of
where in the code it's invoked from). Moving the call site only removes the
unsafe *nesting*; it does not trade away anything that was ever really
provided. **New failure-mode consequence, explicitly accepted and
documented:** if the domain write commits but the subsequent (separately-
transacted) ledger post then fails, the domain state (loan disbursed,
repayment applied, penalty charged) is **not** rolled back — the failure is
caught, logged (`Logger.error`), and for the two interactive/user-facing
call sites (disbursement, repayment) also recorded as a dedicated audit
entry (`LEDGER_POST_DISBURSEMENT_FAILED` / `LEDGER_POST_REPAYMENT_FAILED`)
so a missing journal entry is a visible, reconcilable ops event rather than
a silently swallowed one. The penalty-sweep call sites log only (no audit
entry) — consistent with that service's own existing conventions for a
batch/cron job (it already reports capped-account state via its returned
`SweepResult`, not audit entries) rather than newly introducing
`AuditService` into a service that never depended on it. **Flagging this for
review**: if a missing ledger entry on a batch sweep needs the same durable
audit trail as the interactive paths, that's a one-line addition once
`AuditService` is injected. As a consequence of this fix, no production call
site passes a `session` anymore — the parameter is retained on the interface
purely because the brief's own sketch specifies it, not because anything
currently exercises it.

Every call site's spec-level assertions (`postDisbursementSpy`/
`postRepaymentSpy`/`postPenaltySpy` `.toHaveBeenCalledWith(...)`) were
updated to drop the now-absent second `session` argument. Full suite
re-verified green after the fix — **35 suites, 344 tests, 6:40** total, no
hang, confirmed clean twice.

## §1 — Chart of accounts and account mapping

Seeded at `AccountingService.onModuleInit` (idempotent via `$setOnInsert`,
safe to run every boot):

| Code | Name                         | Type    |
|------|------------------------------|---------|
| 1010 | Cash/Bank — Branch Operations| ASSET   |
| 1020 | Loans Receivable             | ASSET   |
| 1030 | Penalty Receivable           | ASSET   |
| 4010 | Fee Income                   | INCOME  |
| 4020 | Interest Income              | INCOME  |
| 4030 | Penalty Income               | INCOME  |

**Penalty Receivable kept separate from Loans Receivable** (the brief left
this as "your call, document it"). Reasoning: a penalty is a distinct
economic event from principal/interest — commingling it into Loans
Receivable would make it impossible to later report "how much of what's
owed is penalty vs. original loan" without re-deriving it from
`JournalEntry.sourceEntityType`. **Flagging for real-accountant review** per
the brief's own explicit request — this is a bookkeeping-policy choice, not
a technical necessity, and a real accountant may prefer folding it into
Loans Receivable for a small cooperative's chart-of-accounts simplicity.

**Interest Income (4020) is seeded but currently uncredited by any automated
posting.** The brief's own five-posting-type default mapping (disbursement,
repayment, fee collection, two penalty types) never separates interest
recognition out of the repayment posting — `postRepayment` credits Loans
Receivable for the full repayment amount, principal and interest together,
same as the brief's literal spec. Interest Income exists in the seeded chart
because the brief's account list named it, but nothing currently posts to
it. **Flagging this explicitly** — if interest revenue needs its own ledger
line (a common real-accounting requirement), that's a Phase 11+-sized
change: splitting each repayment into its principal/interest components
(the schedule already carries this split per installment) and posting two
lines instead of one.

**Account mapping** (`AccountMapping { key, accountId }`) is stored as data,
not hardcoded — seeded via `DEFAULT_MAPPING` at the same `onModuleInit`,
resolving every `AccountMappingKey` to a real seeded `Account._id` (tested:
`resolveMappedAccountId` succeeds for every key in the enum). Default
mapping, exactly per the brief:

- Disbursement: Dr Loans Receivable (1020), Cr Cash/Bank (1010)
- Repayment: Dr Cash/Bank (1010), Cr Loans Receivable (1020)
- Fee collection: Dr Cash/Bank (1010), Cr Fee Income (4010)
- Penalty (both `PENALTY_CHARGE` and `LIQUIDATION_DELAY_CHARGE`): Dr Penalty
  Receivable (1030), Cr Penalty Income (4030)

**Confirm this mapping is sensible** — per the brief's own explicit request,
this is exactly the kind of thing worth a real accountant's sign-off rather
than an engineer's best guess. Everything above is implemented and tested
against this mapping, but the mapping itself is a policy choice this project
has not had independently verified.

## Chart-of-accounts CRUD vs. workflow engine — not workflow-mediated, flagged

Same reasoning as Phase 3's org-structure CRUD (branches/units): chart of
accounts and account mapping are foundational configuration, not day-to-day
transactional business events — `Account` create/update and
`AccountMapping` update are gated behind `ACCOUNTING_MANAGE_CAPABILITY`
(`'accounting:manage_accounts'`, granted to ADMIN/SUPERADMIN) via
`AccountingConfigController`, **not** routed through `WorkflowEngineService`.
**Flagging this as an assumption to confirm** — the brief left this decision
open ("your call") the same way it did for Phase 3, and a coop that wants
maker-checker on its own chart of accounts would need this changed.

## §4 — Manual journal entries

Read access (`GET` balance/trial-balance/ledger entries) is open to any
staff with `ModuleName.ACCOUNTING` module access — no capability check
beyond module membership, per the brief's "basic accounting operations
accessible to all users." This is the first phase to actually exercise
`@RequireModule(ModuleName.ACCOUNTING)`/`ModuleAccessGuard` — pre-built in
Phase 2/3, confirmed via grep to be unused anywhere until now.

Proposing a manual entry is also open to any ACCOUNTING-module staff, but
routed through the workflow engine (`WorkflowEntityType.MANUAL_JOURNAL_ENTRY`,
new this phase; single-step Admin/SuperAdmin approval only — a free-form
manual entry is unstructured, error-prone, and fraud-prone in a way
automated postings (already gated by their own upstream approvals) are not,
so it gets a second set of eyes). `ManualJournalEntryService.proposeEntry`
validates the proposed lines balance (`assertJournalLinesBalanced`) *and*
that every referenced account actually exists, **before** calling
`WorkflowEngine.initiate` — same "don't create a doomed-to-fail request"
principle as Phase 6 — tested: an unbalanced or bad-account proposal creates
zero `WorkflowRequest` documents.

On `workflow.approved`, the entry posts with `sourceEntityType: 'MANUAL'`
(reusing the pre-existing Phase 1/2 `JournalSourceEvent.MANUAL_ADJUSTMENT`
enum value — same meaning as the brief's literal "MANUAL", pre-existing name
kept rather than adding a synonym) and `sourceRef` derived from the
`WorkflowRequest._id` — unique per proposal by construction, no idempotency
concern (a one-shot human action, not a retryable automated posting). Tested:
not persisted until approval, `createdBy` set to the actual proposer (not
the approver), and a distinct maker/checker actor pair used in the test
fixture (`ADMIN_ID` approves, a separate `MAKER_ID` proposes) — the engine's
own maker≠checker guard would otherwise reject a test that used the same
identity for both.

## §2/§3/§5 — everything else, briefly

- Balance validation (`assertJournalLinesBalanced`) is a single shared pure
  function used by both `LedgerPostingService` (automated) and
  `ManualJournalEntryService` (manual) — enforced once, not duplicated.
  Rejects: empty lines array, any line with debit/credit both set or neither
  set, or Σdebit ≠ Σcredit. Tested directly and via both consuming services.
- `getAccountBalance(accountId, asOfDate?)` returns a **signed** balance per
  normal-balance convention (ASSET/EXPENSE debit-normal, LIABILITY/EQUITY/
  INCOME credit-normal) — tested for both an ASSET and an INCOME account, so
  a healthy INCOME account reads positive, not the raw (and misleadingly
  negative) debit-minus-credit.
- `getTrialBalance(asOfDate?, branchId?)` sums every account and asserts
  `totalDebitKobo === totalCreditKobo` system-wide — a genuine sanity check
  that would catch any bug letting an unbalanced entry slip past the service
  layer. Tested against a realistic mixed set (one automated disbursement +
  one automated fee collection), asserting `balanced: true` and each
  account's exact signed balance, including the Cash/Bank account correctly
  reading a large *negative* balance (credited 200,000 for the disbursement,
  debited only 3,000 for the fee — an ASSET ledger account's own normal-debit
  balance, a distinct concept from `BranchFundBalance`, which tracks the
  actual bankable cash position and is never negative by Phase 4's own
  invariant).
- `getLedgerEntries(accountId, dateRange?, branchId?)` — paginated, for
  reconciliation/audit; not deeply exercised beyond basic coverage since it's
  outside the brief's required-tests list.
- No HTTP endpoint exposes `WorkflowEngineService.act()` directly anywhere in
  this codebase, including this phase — consistent with every prior phase,
  not a new gap introduced here.

## Grep evidence — every Phase 8/9 stub call now resolves to a real posting

```
StubLedgerPostingPort — only referenced in:
  loans.service.spec.ts, repayments-test-context.ts   (test fixtures only)

LEDGER_POSTING_PORT provider bindings:
  loans.module.ts            → useExisting: LedgerPostingService   (PRODUCTION)
  loans.service.spec.ts      → useExisting: StubLedgerPostingPort  (test)
  repayments-test-context.ts → useExisting: StubLedgerPostingPort  (test)

Production call sites (all object-param form, no positional args, no session):
  loan-verification.service.ts:501  postDisbursement({...})
  fee-payments.service.ts:94        postFeeCollection({...})
  penalty-sweep.service.ts:327,511  postPenalty({...}) ×2
  repayments.service.ts:372         postRepayment({...})
```

Confirmed: the real `LedgerPostingService` is bound in production
(`AppModule` → `AccountingModule` + `LoansModule`'s `useExisting` rebind),
and every one of the five real call sites (four method names, five
invocations counting `postPenalty`'s two source types) calls the real
service. No leftover stub usage or stale positional-arg calls anywhere
outside test fixtures.

## Deliverable

- `src/modules/accounting/`: `Account`/`AccountMapping`/`JournalEntry`
  schemas; `journal-balance.util.ts` (shared balance validation);
  `AccountingService` (seeding, chart-of-accounts CRUD, mapping CRUD, read
  surface); `LedgerPostingService` (real `LedgerPostingPort`
  implementation); `ManualJournalEntryService` (propose/approve workflow);
  DTOs; `AccountingConfigController`/`LedgerController`; module.
- `LEDGER_POSTING_PORT` rebound to the real service in `LoansModule`
  (`RepaymentsModule` inherits this transparently — it already imports
  `LoansModule` to reuse the token, no changes needed there).
- The `LedgerPostingPort` interface reconciliation (finalized signature,
  Phase 8/9 call sites adjusted) — its own item, as requested.
- The nested-transaction deadlock discovery and fix across all four real
  call sites — the most significant finding of this phase, found only
  because the full suite (not just the new module in isolation) was run to
  completion rather than assumed clean.
- The `postFeeCollection` gap fix (a genuine missing Phase 8 call site, not
  a stub).
- Full test suite per the brief's required-tests list, green — idempotency
  and concurrency tests treated with the same weight as Phase 4's
  fund-balance race test, per the brief's own instruction.

## Verification gates — all green

`tsc --noEmit` clean · `eslint` clean · `prettier --check` clean ·
`nest build` clean · full unit suite: **35 suites / 344 tests**, run twice
end-to-end with no hang (399.83s and previously confirmed per-module) ·
`test:e2e`: 1/1 · `npm audit --omit=dev`: 0 vulnerabilities · boot smoke test
(disburse → repay → penalty-sweep → manual-entry propose/approve, all
producing real `JournalEntry` documents; trial balance checked balanced)
run and deleted.

Do not start Phase 11 (Notifications) until this is reviewed — in
particular, the two "confirm with me" items flagged above (the default
account mapping, and the Penalty-Receivable-vs-Loans-Receivable chart
decision) are policy choices, not technical ones, and this project's own
discipline treats those as blocking on review, not just informational.
