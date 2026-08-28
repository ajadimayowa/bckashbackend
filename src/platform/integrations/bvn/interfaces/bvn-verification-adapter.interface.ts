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
 * (`directVerify(bvn)`) has no way to carry this itself. Optional so it
 * doesn't change call sites that don't have this context yet.
 */
export interface BvnCallContext {
  calledBy: string;
  entityType: 'CUSTOMER' | 'STAFF';
  entityId?: string;
}

/**
 * Maps to the real, documented BC Kash MFB API contract (see "BC Kash MFB
 * API Integration Documentation"): a single `POST {BVN_QUERY_BASEURL}/identity/get_bvn`
 * call, `{bvn}` in, `{RequestStatus, isBvnValid, bvnDetails}` out — no
 * OTP/consent step exists on this provider at all. An earlier version of
 * this interface modeled a 3-endpoint OTP-consent flow
 * (initiateConsent/confirmConsent/directVerify) based on a different,
 * unconfirmed provider contract; that flow doesn't correspond to anything
 * this actual provider does (confirmed by the 404s it returned — see
 * BvnCallLog entries for step CONSENT_INITIATE) and has been removed.
 * `directVerify` — always live, no caching — is the provider's only real
 * capability, used identically for customer onboarding, staff onboarding,
 * and later re-verification (loan disbursement).
 */
export interface BvnVerificationAdapter {
  directVerify(bvn: string, context?: BvnCallContext): Promise<BvnDetails>;
}

export const BVN_VERIFICATION_ADAPTER = Symbol('BVN_VERIFICATION_ADAPTER');
