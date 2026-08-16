export enum KycStatus {
  INCOMPLETE = 'INCOMPLETE',
  PENDING_VERIFICATION = 'PENDING_VERIFICATION',
  VERIFIED = 'VERIFIED',
}

/** Which provider check a KycVerification record represents. */
export enum KycCheckType {
  BVN = 'BVN',
  NIN = 'NIN',
}

export enum KycCheckOutcome {
  MATCH = 'MATCH',
  MISMATCH = 'MISMATCH',
  PROVIDER_ERROR = 'PROVIDER_ERROR',
}
