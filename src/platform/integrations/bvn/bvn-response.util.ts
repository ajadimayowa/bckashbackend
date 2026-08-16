import { decode as decodeJwt } from 'jsonwebtoken';

import { BvnDetails } from './interfaces/bvn-verification-adapter.interface';

/**
 * The confirmed source controller wraps its own responses inconsistently —
 * `/bvn/verify` returns `{ message, data }`, `/bvn/verify-user-kyc-consent`
 * returns `{ message, payload }`, both of which then pass through a global
 * response-formatting middleware that *itself* re-wraps unrecognized shapes
 * in another `{ success, payload }` envelope, occasionally double-nesting
 * `payload`. Rather than hard-code one exact shape (which may not even match
 * whatever's actually deployed at BVN_QUERY_BASEURL — see PHASE_5_NOTES.md),
 * this unwraps up to two levels of `{ payload: ... }` / `{ data: ... }`
 * nesting and lands on whatever's left, which covers every shape found
 * during investigation.
 */
export function unwrapEnvelope(raw: unknown): Record<string, unknown> {
  let current = raw;

  for (let i = 0; i < 2; i++) {
    if (current && typeof current === 'object') {
      const obj = current as Record<string, unknown>;
      if (obj.payload && typeof obj.payload === 'object') {
        current = obj.payload;
        continue;
      }
      if (obj.data && typeof obj.data === 'object') {
        current = obj.data;
        continue;
      }
    }
    break;
  }

  return (current && typeof current === 'object' ? current : {}) as Record<string, unknown>;
}

export function extractMessage(unwrapped: Record<string, unknown>): string | undefined {
  const message = unwrapped.message ?? unwrapped.error;
  return typeof message === 'string' ? message : undefined;
}

/** Only ever a string, or '' — never `String(unknown)`, which would stringify a stray object into "[object Object]". */
function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Field names (bvn, firstName, dateOfBirth, raw, ...) confirmed against the source's own BvnDetails shape. */
export function mapToBvnDetails(unwrapped: Record<string, unknown>): BvnDetails {
  return {
    bvn: stringField(unwrapped.bvn),
    firstName: stringField(unwrapped.firstName),
    lastName: stringField(unwrapped.lastName),
    otherNames: typeof unwrapped.otherNames === 'string' ? unwrapped.otherNames : undefined,
    dateOfBirth: stringField(unwrapped.dateOfBirth),
    phoneNumber: stringField(unwrapped.phoneNumber),
    rawResponse: (unwrapped.raw as Record<string, unknown>) ?? unwrapped,
  };
}

/** Decodes (does NOT verify — we don't hold the issuing provider's signing secret) the `exp` claim, in ms epoch. */
export function decodeJwtExpiryMs(token: string): number | null {
  try {
    const decoded = decodeJwt(token);
    if (decoded && typeof decoded === 'object' && typeof decoded.exp === 'number') {
      return decoded.exp * 1000;
    }
  } catch {
    // fall through to null
  }
  return null;
}
