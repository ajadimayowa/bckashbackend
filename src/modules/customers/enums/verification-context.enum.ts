/**
 * PRE_DISBURSEMENT/CHEQUE_PICKUP added in Phase 8, exactly as this file's own
 * Phase 1/2 comment anticipated ("Extend in Phase 8 with 'PRE_DISBURSEMENT',
 * 'CHEQUE_PICKUP'"). Both are used for the same BVN direct-recheck call
 * (LoanVerificationService reuses CustomerService.recordBvnDirectVerifyForContext) —
 * split in two only so the KYC audit trail can distinguish which channel a given
 * recheck happened under, since LoansService's own DisbursementVerification record
 * already carries `channel` separately. See PHASE_8_NOTES.md.
 */
export enum VerificationContext {
  KYC_CAPTURE = 'KYC_CAPTURE',
  PRE_DISBURSEMENT = 'PRE_DISBURSEMENT',
  CHEQUE_PICKUP = 'CHEQUE_PICKUP',
}
