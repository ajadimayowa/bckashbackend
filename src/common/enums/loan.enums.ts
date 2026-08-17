/**
 * SUPERSEDES the Phase 1/2 forward-looking placeholder that used to live in this
 * file (LoanStatus with PENDING/VERIFICATION_PENDING/DISBURSEMENT_PENDING/ACTIVE,
 * plus DisbursementMethod/PreDisbursementVerificationStatus/ChequePickupVerificationStatus/
 * DisbursementStatus/ScheduleEntryStatus). That placeholder had zero usages anywhere
 * in the codebase (confirmed via grep before overwriting — same "flag, don't silently
 * overwrite" handling as Phase 6/7's group.enums.ts / loan-product.enums.ts). Its shape
 * also diverged from Phase 8's actual brief in a few ways worth recording:
 *   - it modeled pre-disbursement verification as TWO separate concepts
 *     (PreDisbursementVerification for transfer, ChequePickupVerification for cheque
 *     pickup); Phase 8's brief explicitly collapses these into one DisbursementVerification
 *     shape per member, with `channel` as a field rather than a type split — see
 *     PHASE_8_NOTES.md for the confirmation that a cheque-pickup check is *the*
 *     pre-disbursement check for that channel, not a second layer on top of it.
 *   - `ScheduleEntryStatus` (PARTIALLY_PAID/OVERDUE/PENALIZED) belongs to Phase 9
 *     (repayments), not this phase — not reused here, left for Phase 9 to define.
 * See PHASE_8_NOTES.md for the full writeup.
 */

/**
 * Top-level lifecycle status of a Loan — exact vocabulary from the Phase 8 brief.
 *
 * `VERIFICATION_FAILED` is kept for schema/type completeness (the brief's own type
 * union includes it, annotated "at least one member escalated"), but per the brief's
 * explicit instruction in §5 ("Do not automatically fail the whole loan — an
 * escalation needs resolution... before the loan can proceed either way"), a member
 * escalation never actually moves `Loan.status` here — it stays at
 * VERIFICATION_IN_PROGRESS while the escalation awaits `resolveEscalation`. This status
 * is therefore currently unreachable by any code path in this phase; flagged rather
 * than silently dropped, in case a future phase revisits this. See PHASE_8_NOTES.md.
 */
export enum LoanStatus {
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  APPROVED = 'APPROVED',
  VERIFICATION_IN_PROGRESS = 'VERIFICATION_IN_PROGRESS',
  VERIFICATION_FAILED = 'VERIFICATION_FAILED',
  DISBURSED = 'DISBURSED',
  REJECTED = 'REJECTED',
  CLOSED = 'CLOSED',
}

/** Loan statuses that block group member removal — see RealLoanStatusPort (groups module). */
export enum MemberLoanAccountStatus {
  PENDING = 'PENDING',
  ACTIVE = 'ACTIVE',
  CLOSED = 'CLOSED',
  DEFAULTED = 'DEFAULTED',
}

/** Statuses considered "pending" for the no-pending-loan group-removal guard. */
export const MEMBER_LOAN_ACCOUNT_STATUSES_BLOCKING_REMOVAL: readonly MemberLoanAccountStatus[] = [
  MemberLoanAccountStatus.PENDING,
  MemberLoanAccountStatus.ACTIVE,
];

export enum DisbursementChannel {
  TRANSFER = 'TRANSFER',
  CHEQUE_PICKUP = 'CHEQUE_PICKUP',
}

/**
 * `FAILED` is kept for type completeness (present in the brief's literal type
 * union) but, like `LoanStatus.VERIFICATION_FAILED` above, is never actually
 * produced by `LoanVerificationService.initiateMemberVerification` — a failing
 * check routes to ESCALATED instead, per the brief's explicit "not a dead end"
 * architecture note. See PHASE_8_NOTES.md.
 */
export enum DisbursementVerificationStatus {
  PENDING = 'PENDING',
  PASSED = 'PASSED',
  FAILED = 'FAILED',
  ESCALATED = 'ESCALATED',
}

export enum FeePaymentStatus {
  PENDING = 'PENDING',
  PAID = 'PAID',
  WAIVED = 'WAIVED',
}
