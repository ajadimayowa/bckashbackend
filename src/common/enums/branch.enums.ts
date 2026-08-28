export enum BranchBankAccountPurpose {
  REPAYMENT_COLLECTION = 'REPAYMENT_COLLECTION',
  DISBURSEMENT_SOURCE = 'DISBURSEMENT_SOURCE',
  GENERAL = 'GENERAL',
}

export enum BranchFundingStatus {
  PENDING_VERIFICATION = 'PENDING_VERIFICATION',
  VERIFIED = 'VERIFIED',
  REJECTED = 'REJECTED',
}

export enum BranchFundingSource {
  HEAD_OFFICE = 'HEAD_OFFICE',
}

/** A branch manager's free-form request to head office (e.g. "we need more float", "our POS terminal is faulty") — see BranchRequest. */
export enum BranchRequestStatus {
  OPEN = 'OPEN',
  RESOLVED = 'RESOLVED',
}
