export interface BvnConsentInitiation {
  /** Opaque to callers — pass back verbatim to confirmConsent. Never log this (see PHASE_5_NOTES.md). */
  consentToken: string;
  /** Masked phone number (e.g. "*******4166"), for UI display only. */
  otpSentToPhone: string;
  /** Decoded from the JWT `exp` claim. */
  expiresAt: Date;
}

export interface BvnDetails {
  bvn: string;
  firstName: string;
  lastName: string;
  otherNames?: string;
  dateOfBirth: string;
  phoneNumber: string;
  rawResponse: Record<string, unknown>;
}

/**
 * Threaded through to BvnCallLogService by the adapter so the resulting
 * BvnCallLog entry's calledBy/calledForEntityType/calledForEntityId are
 * populated — the base interface signature given in the brief
 * (`initiateConsent(bvn)`, etc.) has no way to carry this itself. A minimal,
 * additive deviation: optional, so it doesn't change call sites that don't
 * have this context yet (e.g. `initiateConsent`/`confirmConsent` run before
 * any Customer document exists, so `entityId` is genuinely unavailable
 * there). See PHASE_5_NOTES.md.
 */
export interface BvnCallContext {
  calledBy: string;
  entityType: 'CUSTOMER' | 'STAFF';
  entityId?: string;
}

/**
 * Maps to the confirmed 3-endpoint contract of the internal BVN query
 * service (POST {BVN_QUERY_BASEURL}/bvn/get-user-consent,
 * /bvn/verify-user-kyc-consent, /bvn/verify) — see PHASE_5_NOTES.md for how
 * this was confirmed and where its auth shape differs from the brief's
 * initial description.
 */
export interface BvnVerificationAdapter {
  initiateConsent(bvn: string, context?: BvnCallContext): Promise<BvnConsentInitiation>;
  confirmConsent(consentToken: string, otp: string, context?: BvnCallContext): Promise<BvnDetails>;
  /** Maps to /bvn/verify — a no-consent recheck, used for staff BVN and later phases' re-verification. */
  directVerify(bvn: string, context?: BvnCallContext): Promise<BvnDetails>;
}

export const BVN_VERIFICATION_ADAPTER = Symbol('BVN_VERIFICATION_ADAPTER');
