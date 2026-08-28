/**
 * MISMATCH_FLAGGED — a marketer may now optionally submit an intake
 * fullName/phoneNumber alongside `POST /customers/bvn-consent/start`
 * (StartBvnConsentDto); `CustomerService.confirmBvnConsent` diffs those
 * against the provider's own resolved name/phone and records any
 * discrepancy on `KycRecord.mismatchFlags`. `recomputeKycStatus` then
 * reports MISMATCH_FLAGGED instead of VERIFIED whenever that array is
 * non-empty, even once BVN + biometric are both done — and
 * `CustomerService.isLoanEligible` only accepts VERIFIED, so an unresolved
 * mismatch blocks loan eligibility. See CustomerService.buildMismatchFlags
 * for the (deliberately lenient) comparison rules.
 */
export enum KycStatus {
  INCOMPLETE = 'INCOMPLETE',
  PENDING_VERIFICATION = 'PENDING_VERIFICATION',
  VERIFIED = 'VERIFIED',
  MISMATCH_FLAGGED = 'MISMATCH_FLAGGED',
}

/**
 * Customer.status — the workflow-mediated onboarding lifecycle, plus
 * DISABLED (an Admin/SuperAdmin/Approver action independent of that
 * workflow — see CustomerService.disable/enable, same pattern as
 * Staff.status).
 *
 * DRAFT is the state a Customer is actually created in (see
 * CustomerService.confirmCustomerFromPreview) — the marketer still has to
 * fill in onboarding details and capture biometrics before there's anything
 * for anyone else to review. It's creator-only visible (see
 * findAllForActor) precisely so a still-mid-onboarding record never shows
 * up in a Manager's/Admin's customer list looking like it's awaiting their
 * action. `submitForApproval` is the one place a DRAFT customer flips to
 * PENDING_APPROVAL — only from there does it become visible to reviewers
 * and gets a real WorkflowRequest.
 */
export enum CustomerStatus {
  DRAFT = 'DRAFT',
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  ACTIVE = 'ACTIVE',
  REJECTED = 'REJECTED',
  DISABLED = 'DISABLED',
}

/** Which kind of document `KycRecord.idDocumentImageKey` is a photo of — a separate concept from NIN (a captured *number*, not a document type). */
export enum IdDocumentType {
  NIN = 'NIN',
  VOTERS_CARD = 'VOTERS_CARD',
}
