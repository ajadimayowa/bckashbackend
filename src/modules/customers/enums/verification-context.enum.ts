/**
 * Extend in Phase 8 with "PRE_DISBURSEMENT", "CHEQUE_PICKUP" — only
 * KYC_CAPTURE exists in this phase (set when BVN consent is confirmed).
 */
export enum VerificationContext {
  KYC_CAPTURE = 'KYC_CAPTURE',
}
