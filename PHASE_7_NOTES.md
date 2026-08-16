# Phase 7 Notes — Loan Products (products, fees, calculation functions)

`src/modules/loan-products/`. **262 unit tests passing** (up from 188 — 74
new: 40 pure calculation tests, 13 FeeDefinitionsService, 17
LoanProductsService, 4 new WorkflowEngineService.replaceChainConfig tests),
1 e2e test, `npm audit --omit=dev` → 0 vulnerabilities. Full build/lint/
format/typecheck clean, plus a boot smoke test confirming the compiled app
boots, a fee and a loan product each go through create→approve, and the
dynamic `LOAN/APPROVE_<productId>` chain registers correctly with the
product's exact `approvalChainSteps`.

## 1. Single-step vs two-step chain — confirmed single-step, with evidence (not a guess)

Unlike Phase 6's Group/Customer correction (single-step → two-step), this
phase confirms **single-step** (Admin proposes, a *different*
Admin/SuperAdmin/Approver confirms — the engine's own maker≠checker rule
still applies even though ADMIN holds every capability in the chain) for
both `FEE_DEFINITION` and `LOAN_PRODUCT`, `CREATE` and `UPDATE` alike. This
isn't a fresh guess — it's backed by Phase 2's own pre-existing, explicit
design documentation in `default-role-capabilities.ts`, written before this
phase existed:

> "ADMIN: reviews + approves everything, **initiates + approves** loan
> product/fee config changes (brief: 'initiated by Admin')"

That comment already distinguishes "config entity types"
(`LOAN_PRODUCT`/`FEE_DEFINITION`, in `CONFIG_ENTITY_TYPES`) from the
maker-entity-type flow (`MAKER_ENTITY_TYPES`, which gets the full
initiate→review→approve treatment). No RBAC seed changes were needed at all
for this phase — `CONFIG_ENTITY_TYPES` already grants ADMIN/SUPERADMIN
initiate, and `ALL_WORKFLOW_ENTITY_TYPES` already grants ADMIN/SUPERADMIN/
APPROVER review+approve for every entity type including these two. This is
the opposite finding from Phase 6: there, unused review-capability
infrastructure was evidence of an *oversight*; here, an explicit code
comment is evidence the single-step shape was *intentional* from the start.

## 2. `appliesTo` — built exactly as asked; proposed defaults for confirmation, not auto-applied

`FeeDefinition.appliesTo` is an explicit, required, admin-set field (`PER_MEMBER`
| `PER_GROUP`) — never inferred from `category`, per the brief. I deliberately
did **not** build server-side category→appliesTo auto-defaulting logic, since
that would directly contradict "not inferred from category" (also stated as
the field's own doc comment in `loan-product.enums.ts`). Proposed defaults
for confirmation, to guide the admin UI/documentation rather than code:

| Category | Proposed default | Reasoning |
|---|---|---|
| `REGISTRATION` | `PER_MEMBER` | Your own default in the brief — each member pays their own. |
| `FORM` | `PER_MEMBER` | Your own default in the brief. |
| `MEMBERSHIP` | `PER_MEMBER` | Flagged as ambiguous in the brief. Defaulting to per-member for consistency with REGISTRATION/FORM (all three read as "cost of an individual joining/participating") — but this is the one to double check; `PER_GROUP` ("the group as a whole pays dues") is equally plausible. |
| `LATE_REPAYMENT` | `PER_MEMBER` | A repayment installment belongs to one member's loan share. |
| `EARLY_LIQUIDATION` | `PER_MEMBER` | Liquidating a balance is a per-member loan action. |
| `OTHER` | `PER_MEMBER` | Safest generic default; no category-specific signal to go on. |

## 3. Rounding rule

Round-half-up throughout (`calculations/rounding.util.ts`'s `roundHalfUp` —
behaviorally identical to `Math.round` since every value in this domain is
non-negative). Picked as a reasonable default in the absence of a stated
coop accounting convention. **Confirm before relying on this** if the coop
has a different rule (e.g. truncate/round-down) for any specific
calculation — it's centralized in one function, so changing it is a
one-file change, not a hunt across the module.

## 4. `calculatePenaltyAmount`'s signature — a deliberate simplification, flagged

The given signature takes a single `overdueAmountKobo: number`, not a
context object with separate `outstanding`/`overdueAmount` slots the way
`calculateFeeAmount` does. Since `penaltyRule.percentageOf` can be
`OUTSTANDING` *or* `OVERDUE_AMOUNT`, but the function only receives one
amount, `calculatePenaltyAmount` does **not** fork behavior on
`percentageOf` — it applies the percentage against whatever
`overdueAmountKobo` it's given, trusting the caller (Phase 9) to have
already selected the correct amount for the rule's configured basis.
`percentageOf` is still validated as present/required for a PERCENTAGE rule
(an unset basis on the rule itself is a real configuration error worth
throwing on), just not used to *select* between two inputs. Documented
directly in the function's own doc comment — flagging here too since it's
an easy detail for a Phase 9 implementer to miss.

## 5. The dynamic chain-registration pattern — confirmed working, exactly as Phase 8 will need it

`LoanProductsService.registerLoanApprovalChain` registers/replaces a `LOAN`
chain under action `APPROVE_<productId>` (see `loanApprovalActionFor`),
built from the product's current `approvalChainSteps`, on every approved
product `CREATE` **and** `UPDATE`. Phase 8 initiates a loan application with
`entityType: "LOAN", action: loanApprovalActionFor(productId)` and gets a
chain shaped exactly the way that product's admin configured it — the
generic engine never needs to know what a "LoanProduct" is.

**One platform-layer addition this required**: `WorkflowEngineService.registerChainConfig`
is idempotent (`$setOnInsert` — insert-only, protects an Admin's later
manual chain edits from being clobbered on every boot). That's wrong for
this use case — a product's `approvalChainSteps` *should* actually update
the registered chain when the product is edited. Added a new sibling method,
`WorkflowEngineService.replaceChainConfig`, which always overwrites
(`$set`, upsert). Directly unit-tested in `workflow-engine.service.spec.ts`
(4 new tests) and exercised end-to-end in `loan-products.service.spec.ts`.

**Confirmed and tested — snapshotting works as expected**: because
`WorkflowEngineService.initiate()` copies `steps` onto the new
`WorkflowRequest` document at creation time (established since Phase 2), a
product update that changes `approvalChainSteps` does **not** retroactively
affect a loan application already mid-approval under the old chain shape —
this is correct, expected behavior, confirmed by a dedicated test
(`loan-products.service.spec.ts`: "updating approvalChainSteps re-registers
the chain for FUTURE loan applications, but does NOT alter the steps
snapshot already inside an in-flight WorkflowRequest") which creates an
in-flight `LOAN` request, updates the product, and asserts both that the
in-flight request's *stored* (re-fetched from DB, not just the in-memory
object) steps are untouched, and that a brand-new request initiated after
the update gets the new chain shape.

## 6. `ALL_KNOWN_CAPABILITIES` — new canonical capability vocabulary

Added to `platform/rbac/constants/capabilities.ts`: every
`workflow:{initiate,review,approve}:<entityType>` for every
`WorkflowEntityType`, plus every flat capability constant.
`LoanProductsService` validates every `approvalChainSteps[].requiredCapability`
against this set (not against "whatever's currently assigned to some role in
the DB," which would wrongly reject a valid-but-unassigned capability) —
catching a typo'd capability string before it can silently create an
unfulfillable approval step. Tested directly (`rejects an approvalChainSteps
entry whose capability is not in the known RBAC capability set`).

## 7. A stale Phase 2 placeholder found and superseded (same pattern as Phase 6)

`src/common/enums/loan-product.enums.ts` already existed — committed in
Phase 2, unused anywhere in the codebase (confirmed by grep before
touching it), with an older/different shape than this phase's actual spec
(`FeeCalculationType` vs `FeeCalcType`, `FeePercentageOfTarget` with
`OUTSTANDING_BALANCE`/`OVERDUE_INSTALLMENT` vs this phase's `FeePercentageBasis`
with `OUTSTANDING`/`OVERDUE_AMOUNT`, a separate unused `PenaltyRuleType`).
Replaced outright to match this phase's explicit spec, flagged here per the
project's "surface what you find, don't silently overwrite" convention —
same situation as Phase 6's `group.enums.ts` placeholder.

## 8. `FeeDefinition.productIds` is informational, not authoritative

The given schema has both `LoanProduct.feeIds` (product → fees) and
`FeeDefinition.productIds` (fee → products) — a bidirectional link with no
described sync mechanism. The authoritative direction is `LoanProduct.feeIds`,
validated on every product create/update against
`FeeDefinitionsService.assertFeesExistAndActive`. `FeeDefinition.productIds`
is stored as whatever an admin sets at fee-creation/update time and is
**not** automatically kept in sync when a product's `feeIds` changes —
documented on the schema field itself. Building real bidirectional sync
wasn't required by this phase's spec or tests; flagging as a known gap
rather than either quietly skipping the field or building unrequested sync
logic.

## 9. Read endpoints — authenticated-only, no capability gate (same reasoning as Phase 6)

`GET /fee-definitions`, `GET /loan-products` (and their `/:id` variants)
require only a valid JWT + resolved staff context, no specific
capability — every staff role that will ever initiate a loan application
(Phase 8) needs to see available products/fees, and neither response
contains PII. Mutating routes (`POST`/`PATCH`) are capability-gated as
normal.

## Deliverable

- `src/modules/loan-products/`: `FeeDefinition`/`LoanProduct` schemas
  (reusing `platform/workflow-engine`'s `WorkflowStepConfig` subdocument
  directly for `approvalChainSteps` rather than redeclaring an identical
  shape), `FeeDefinitionsService`/`LoanProductsService` (workflow-gated
  CRUD), DTOs (nested `ApprovalChainStepDto`/`PenaltyRuleDto` via
  class-transformer `@ValidateNested`), controllers, module.
- `calculations/`: pure, side-effect-free functions —
  `calculateFeeAmount`, `calculateEarlyLiquidationFee`,
  `calculateFlatInterestSchedule`, `calculateReducingBalanceSchedule`,
  `calculatePenaltyAmount` — exported via a barrel `index.ts` for Phases
  8–9 to import directly. 40 tests covering exact-value FIXED/PERCENTAGE
  math, rounding boundaries, missing-context/negative/non-integer-input
  throws, zero-tenure and single-installment edge cases, large principals,
  0% rate, non-evenly-dividing tenures (rounding-remainder-on-last-installment
  correctness), and reducing-balance's installment-over-installment interest
  decline.
- `WorkflowEngineService.replaceChainConfig` — new platform-layer method
  (force-overwrite upsert), directly tested.
- `platform/rbac/constants/capabilities.ts`'s new `ALL_KNOWN_CAPABILITIES`.

Do not start Phase 8 (Loans) until this is reviewed — Phase 8 imports the
calculation functions and the `loanApprovalActionFor`/dynamic-chain pattern
directly and depends on both being trustworthy.
