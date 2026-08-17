/**
 * Internal decoupling event — emitted by `RepaymentsService.applyToBalance`
 * only when it actually performed a balance decrement (never on an idempotent
 * no-op re-fire). `EarlyLiquidationService` listens for this to check whether
 * a just-applied repayment completes a linked liquidation, without
 * `RepaymentsService` needing to know `EarlyLiquidationService` exists —
 * same event-driven decoupling principle as the workflow engine's own
 * `WORKFLOW_APPROVED_EVENT` (GroupsService/CustomerService/LoanProductsService
 * all listen independently, no direct dependency on each other). See
 * PHASE_9_NOTES.md.
 */
export const REPAYMENT_APPLIED_EVENT = 'repayment.applied';

export interface RepaymentAppliedEvent {
  repaymentRecordId: string;
}
