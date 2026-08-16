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
