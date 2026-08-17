/**
 * Normalizes a Nigerian phone number to the international form Termii
 * expects for its `to` field — digits only, no leading `+`, country code
 * `234` prepended (e.g. `08012345678` -> `2348012345678`,
 * `+2348012345678` -> `2348012345678`, `2348012345678` unchanged).
 *
 * *** NOT VERIFIED AGAINST A LIVE TERMII CALL — SEE PHASE_11_NOTES.md ***
 * This is Termii's own documented convention, applied defensively at the
 * adapter boundary rather than trusting whatever format the caller passes
 * (`Customer.phoneNumber`/`Staff.phoneNumber` are stored in whatever form
 * they were captured in). The user explicitly deferred a live sandbox
 * verification (real, billed SMS) for this phase — flagged, not silently
 * assumed correct.
 */
export function normalizePhoneNumberForTermii(rawPhoneNumber: string): string {
  const digitsOnly = rawPhoneNumber.replace(/[^\d]/g, '');

  if (digitsOnly.startsWith('234')) {
    return digitsOnly;
  }
  if (digitsOnly.startsWith('0')) {
    return `234${digitsOnly.slice(1)}`;
  }
  // Already missing both the leading 0 and the 234 prefix (e.g. captured as
  // "8012345678") — prepend the country code as a last resort rather than
  // sending a malformed number as-is.
  return `234${digitsOnly}`;
}
