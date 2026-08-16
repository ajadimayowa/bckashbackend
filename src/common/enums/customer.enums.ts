/**
 * MISMATCH_FLAGGED is modeled (schema + enum) for completeness against the
 * spec's `KycRecord.mismatchFlags` field, but has no active producer in this
 * phase — see PHASE_5_NOTES.md. The BVN-consent-first flow means provider
 * data arrives *before* the rest of the customer record is filled in and
 * pre-fills it, rather than the customer submitting data that's cross-checked
 * against a provider response afterward, so there's no natural point in this
 * phase's flow where a submitted-vs-provider mismatch would arise (identity
 * fields sourced from BVN — name, DOB, phone — aren't editable after
 * consent). Kept in the state space for when/if that changes.
 */
export enum KycStatus {
  INCOMPLETE = 'INCOMPLETE',
  PENDING_VERIFICATION = 'PENDING_VERIFICATION',
  VERIFIED = 'VERIFIED',
  MISMATCH_FLAGGED = 'MISMATCH_FLAGGED',
}

/** Customer.status — the workflow-mediated onboarding lifecycle. */
export enum CustomerStatus {
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  ACTIVE = 'ACTIVE',
  REJECTED = 'REJECTED',
}
