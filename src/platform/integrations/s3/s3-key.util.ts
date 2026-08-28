import { randomUUID } from 'node:crypto';

/**
 * `kyc/{customerId}/{documentType}/{uuid}.{ext}` — predictable and
 * namespaced by customer + document type, so bucket-level lifecycle/retention
 * policies can be applied by prefix later (e.g. auto-expire `kyc/*` after N
 * years) without touching application code.
 */
export function buildKycObjectKey(
  customerId: string,
  documentType: string,
  fileExtension: string,
): string {
  const ext = fileExtension.replace(/^\./, '').toLowerCase();
  return `kyc/${customerId}/${documentType}/${randomUUID()}.${ext}`;
}

/** `repayments/{repaymentId}/{uuid}.{ext}` — same namespacing convention as buildKycObjectKey. Added in Phase 9 for RepaymentRecord.proofOfPaymentImageKey. */
export function buildRepaymentProofObjectKey(repaymentId: string, fileExtension: string): string {
  const ext = fileExtension.replace(/^\./, '').toLowerCase();
  return `repayments/${repaymentId}/${randomUUID()}.${ext}`;
}

/** `loans/member-accounts/{memberLoanAccountId}/{uuid}.{ext}` — same namespacing convention as buildKycObjectKey. For MemberLoanAccount.applicantPhotoImageKey. */
export function buildLoanApplicantPhotoObjectKey(
  memberLoanAccountId: string,
  fileExtension: string,
): string {
  const ext = fileExtension.replace(/^\./, '').toLowerCase();
  return `loans/member-accounts/${memberLoanAccountId}/${randomUUID()}.${ext}`;
}

/**
 * `organisation/{documentType}/{uuid}.{ext}` — no entity id in the path since
 * Organisation is a singleton (see modules/organisation). Same namespacing
 * convention as buildKycObjectKey.
 */
export function buildOrganisationDocumentObjectKey(
  documentType: string,
  fileExtension: string,
): string {
  const ext = fileExtension.replace(/^\./, '').toLowerCase();
  return `organisation/${documentType}/${randomUUID()}.${ext}`;
}

/** `branch-funding/{fundingId}/disputes/{uuid}.{ext}` — same namespacing convention as buildKycObjectKey. For BranchFunding.disputeDetails.evidenceImageKey. */
export function buildBranchFundingDisputeEvidenceObjectKey(
  fundingId: string,
  fileExtension: string,
): string {
  const ext = fileExtension.replace(/^\./, '').toLowerCase();
  return `branch-funding/${fundingId}/disputes/${randomUUID()}.${ext}`;
}
