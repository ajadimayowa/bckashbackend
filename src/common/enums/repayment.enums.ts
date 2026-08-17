/**
 * UNDER_DISPUTE is a distinct branch, not a synonym for rejected — it requires a
 * mandatory reason and an explicit resolution back to APPROVED or REJECTED.
 * A repayment only reduces the loan's outstanding balance once APPROVED.
 */
export enum RepaymentStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  UNDER_DISPUTE = 'UNDER_DISPUTE',
  REJECTED = 'REJECTED',
}

/** Added in Phase 9 — see modules/repayments/schemas/repayment-record.schema.ts. */
export enum RepaymentChannel {
  BANK_TRANSFER = 'BANK_TRANSFER',
  POS = 'POS',
}

/**
 * PENDING_APPROVAL/APPROVED/REJECTED mirror the workflow lifecycle;
 * COMPLETED is a distinct, later state reached only once a linked
 * RepaymentRecord settling the full totalPayableKobo is itself APPROVED —
 * see EarlyLiquidationService.
 */
export enum EarlyLiquidationStatus {
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  COMPLETED = 'COMPLETED',
}
