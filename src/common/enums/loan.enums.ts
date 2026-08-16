/**
 * Top-level lifecycle status of a Loan. Deliberately uses the exact vocabulary the
 * brief itself uses for the group-membership eligibility check ("no pending loan —
 * PENDING, ACTIVE, or DISBURSEMENT_PENDING") rather than inventing finer-grained
 * names, so that check can filter on these literal values.
 *
 * Granular sub-states live on the records that own them, not duplicated here:
 * - the approval chain's step-by-step progress lives on the linked WorkflowRequest
 * - the pre-disbursement verification gate's own PENDING/PASSED/FAILED lives on
 *   PreDisbursementVerification
 * - the cheque-pickup facial/BVN recheck's own status lives on ChequePickupVerification
 *
 * TODO(business rule): what happens after a VERIFICATION_FAILED / escalation is
 * resolved by Admin/Approver — does the loan return to VERIFICATION_PENDING for a
 * recheck, or move straight to REJECTED? Not specified; flagging rather than guessing.
 * Same open question for a DEFAULTED-style status once a loan is severely overdue —
 * omitted here pending a confirmed definition of "default" for this product.
 */
export enum LoanStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  VERIFICATION_PENDING = 'VERIFICATION_PENDING',
  VERIFICATION_FAILED = 'VERIFICATION_FAILED',
  DISBURSEMENT_PENDING = 'DISBURSEMENT_PENDING',
  ACTIVE = 'ACTIVE',
  CLOSED = 'CLOSED',
}

/** Loan statuses that block adding/removing group members (see groups module). */
export const LOAN_STATUSES_BLOCKING_GROUP_MUTATION: readonly LoanStatus[] = [
  LoanStatus.PENDING,
  LoanStatus.ACTIVE,
  LoanStatus.DISBURSEMENT_PENDING,
];

export enum DisbursementMethod {
  BANK_TRANSFER = 'BANK_TRANSFER',
  CHEQUE_PICKUP = 'CHEQUE_PICKUP',
}

export enum PreDisbursementVerificationStatus {
  VERIFICATION_PENDING = 'VERIFICATION_PENDING',
  VERIFICATION_PASSED = 'VERIFICATION_PASSED',
  VERIFICATION_FAILED = 'VERIFICATION_FAILED',
}

/** Do not auto-deny on failure — ESCALATED routes to Admin/Approver for a decision. */
export enum ChequePickupVerificationStatus {
  PENDING = 'PENDING',
  PASSED = 'PASSED',
  FAILED = 'FAILED',
  ESCALATED = 'ESCALATED',
}

export enum DisbursementStatus {
  PENDING = 'PENDING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

export enum ScheduleEntryStatus {
  PENDING = 'PENDING',
  PARTIALLY_PAID = 'PARTIALLY_PAID',
  PAID = 'PAID',
  OVERDUE = 'OVERDUE',
  PENALIZED = 'PENALIZED',
  CLOSED = 'CLOSED',
}
