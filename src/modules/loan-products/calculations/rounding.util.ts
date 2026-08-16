/**
 * Shared guards/rounding for every pure calculation function in this
 * module — see PHASE_7_NOTES.md for the rounding rule. All amounts in this
 * domain (kobo, basis points, day counts) are non-negative integers; a
 * float or a negative number leaking in from upstream is a bug to throw on
 * loudly, not silently coerce.
 */

export function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer, got ${value}`);
  }
}

export function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer, got ${value}`);
  }
}

/**
 * Round-half-up to the nearest integer kobo. Named separately from a bare
 * `Math.round` purely for documentation — every amount here is non-negative,
 * and `Math.round` already rounds .5 up (not to-even, not away-from-zero)
 * for non-negative inputs, so this is behaviorally just `Math.round`.
 * Round-half-up was picked as a reasonable default in the absence of a
 * stated coop accounting convention — confirm before relying on it if the
 * coop has a different rule (e.g. round-down/truncate) for any specific
 * calculation. See PHASE_7_NOTES.md.
 */
export function roundHalfUp(value: number): number {
  return Math.round(value);
}
