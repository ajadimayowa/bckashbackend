export interface FaceComparisonResult {
  isMatch: boolean;
  similarityPercent: number;
  rawResponse: Record<string, unknown>;
}

/**
 * Threaded through to FaceComparisonCallLogService so the resulting log entry's
 * `calledBy`/loan/member linkage is populated — same additive-optional-parameter
 * precedent as BvnCallContext (platform/integrations/bvn), not a literal part of
 * the brief's 2-arg `compareFaces(sourceImageKey, targetImageBuffer)` signature.
 * See PHASE_8_NOTES.md.
 */
export interface FaceComparisonCallContext {
  calledBy: string;
  loanId?: string;
  memberLoanAccountId?: string;
  customerId?: string;
}

/**
 * `sourceImageKey` is the S3 key of the customer's KYC biometric image (Phase 5,
 * `KycRecord.biometricImageKey`). The real adapter downloads it via the S3
 * adapter and sends it to Rekognition as raw `Bytes`, not an `S3Object`
 * reference — this decouples the KYC bucket's region from the Rekognition
 * endpoint's region (Rekognition requires an `S3Object`'s bucket to be in the
 * same region as the API call, but has no such restriction on `Bytes`).
 * `targetImageBuffer` is the freshly captured live image — also passed as raw
 * `Bytes`, and never written anywhere by this adapter or its callers; it is
 * discarded once this call returns (see PHASE_8_NOTES.md's retention-policy
 * note — default is "do not retain the live capture", flagged as worth
 * confirming).
 */
export interface FaceComparisonAdapter {
  compareFaces(
    sourceImageKey: string,
    targetImageBuffer: Buffer,
    context?: FaceComparisonCallContext,
  ): Promise<FaceComparisonResult>;
}

export const FACE_COMPARISON_ADAPTER = Symbol('FACE_COMPARISON_ADAPTER');
