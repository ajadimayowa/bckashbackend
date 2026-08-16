# Phase 4 Notes — Branch Bank Accounts, Funding, Fund Balance

Added to `src/modules/branches/`: `BranchBankAccount`, `BranchFunding`, `BranchFundBalance`
schemas and services. **113 unit tests passing** (up from 90), plus a full-app boot
smoke test confirming every new route maps and the new capabilities seed correctly.

## Decisions you asked to have flagged explicitly

### 1. Funding verification kept outside the workflow engine
`recordFunding`/`verifyFunding`/`rejectFunding` do **not** go through
`WorkflowEngineService` — implemented exactly per your default lean. Reasoning,
stated plainly: the workflow engine's value is a *configurable, multi-step*
maker-checker chain (review → approve, potentially more steps, different
capability per step). Funding verification is structurally different — it's a
**fixed two-party handshake** tied to a specific person by business rule ("the
branch's *current* manager," not "anyone holding an approve capability"), not
a chain of increasingly senior reviewers. Routing it through the engine would
mean either (a) a workflow chain of exactly one step whose capability check
the engine can't express ("must be *this specific* branch's *current*
manager" isn't a capability string, it's a data lookup against
`BranchManagerAssignment`), or (b) teaching the engine about branch-manager
identity, which breaks its entity-agnostic design from Phase 2. Direct
service-layer verification with its own actor check is the better fit.
**If you'd rather this go through the workflow engine anyway** (e.g. because
you want the generic "pending my action" query in Phase 2 to surface unverified
fundings too), that's a real cost of this choice worth naming: right now a
branch manager has to know to check `GET /branch-funding?branchId=...`
specifically, rather than seeing it in one unified pending-actions view.

### 2. Testing true concurrency for the debit race
`BranchFundBalanceService.debit()`'s test fires two real concurrent calls via
`Promise.allSettled([service.debit(...), service.debit(...)])` against a
**real MongoDB replica set** (`mongodb-memory-server`, not a mock) — both
promises are in flight before either resolves, and MongoDB's own atomic
`findOneAndUpdate` with the `{ availableAmount: { $gte: amount } }` filter is
what actually adjudicates which one wins. This is the same pattern used for
Phase 2's workflow-engine step-approval race test. Verified two scenarios:
- balance = 100,000, two debits of 80,000 each → exactly one fulfills, one
  rejects with `InsufficientBranchFundsException`, final balance = 20,000
  (not 100,000, not −60,000, not double-decremented).
- balance = 200,000, two debits of 80,000 each (both satisfiable) → both
  succeed, final balance = 40,000.

A mocked/sequential version of this test would prove nothing about the atomic
guard itself — the whole point was ruled out as acceptable, per your
instruction, so this uses the real driver throughout.

The transaction-rollback test (funding verification) works the same way:
`BranchFundBalanceService` is provider-overridden with a `credit` that throws,
while the *real* `session.withTransaction(...)` machinery runs against the
real replica set — proving MongoDB's own transaction rollback, not just a
try/catch in application code.

## Other implementation notes

- **`BranchFundBalance` initialization**: added a `branch.created` event,
  emitted from `BranchesService.create()` (Phase 3 file — one `emitAsync` call
  added, not a rewrite) and consumed by a `@OnEvent` listener in
  `BranchFundBalanceService`. Idempotent via `$setOnInsert` + `upsert`, so a
  redelivered event can't reset an existing balance.
- **`credit`/`debit` accept an optional `ClientSession`**, exactly as
  specified — `verifyFunding` is the first caller (bundles the funding status
  update and the balance credit into one `session.withTransaction(...)`); Phase 8's
  disbursement flow will be the second (balance debit + loan status + ledger
  entry, all-or-nothing).
- **`InsufficientBranchFundsException`** extends `ConflictException` (409) —
  the request is well-formed, the branch's current state just conflicts with it.
- **Bank account duplicate-key errors** are translated to `ConflictException`
  by checking `err.code === 11000` rather than `err instanceof MongoServerError`.
  Found the hard way: mongoose vendors its own nested copy of the `mongodb`
  driver, which is a *different module instance* than one imported directly at
  this package's top level — `instanceof` silently failed across that
  boundary in a real (non-mocked) test against `mongodb-memory-server`, even
  though the error genuinely was a duplicate-key error. Duck-typing on the
  numeric error code sidesteps the whole problem and is the more common
  pattern for this exact reason.
- **No delete endpoint for `BranchBankAccount`**, per your explicit
  conditional instruction. Phase 9 (repayments) doesn't exist yet, so there's
  no `Repayment` collection to check "zero references" against — building a
  conditional-delete endpoint now would mean guessing at a schema that doesn't
  exist. `PATCH { active: false }` is the only retirement path today; add the
  conditional delete once Phase 9 lands, if still wanted then.
- **New capabilities**: `branch:manage_accounts` (bank account CRUD,
  ADMIN/SUPERADMIN), `branch:fund` (recording head-office funding,
  ADMIN/SUPERADMIN), `branch:verify_funding` (MANAGER — a coarse "you're a
  manager" gate; the specific "*this branch's* manager" rule is enforced in
  `BranchFundingService`, not by the capability system, since RBAC has no
  concept of "which branch does this staff member manage").

## Open questions before Phase 5

None that block Phase 5 (Customers/KYC doesn't depend on this module). Two
worth your attention before Phase 8 (disbursement) starts leaning on this
primitive, though:

1. **Confirm the funding-verification-outside-the-workflow-engine decision**
   above — it's the one part of this phase that's a genuine design fork
   rather than a mechanical implementation choice.
2. **`debit`'s atomicity guarantee is per-branch, not global.** Two
   *different* branches' disbursements can proceed fully in parallel (as
   intended) — just confirming that's the expected model, since nothing in
   the brief suggested any cross-branch fund pooling or shared ceiling.

Ready for Phase 5 (Customers/KYC).
