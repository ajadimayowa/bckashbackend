/**
 * Small formatting helpers shared by both the SMS bodies (notification-templates.ts)
 * and the HTML email templates (templates/emails/) — kept here, one level
 * below both, so neither has to import from the other.
 */

/** Local to notification templates only — no other module needs a kobo->naira display formatter. */
export function naira(amountKobo: unknown): string {
  const amount = typeof amountKobo === 'number' ? amountKobo : 0;
  return `₦${(amount / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Narrows an `unknown` payload field to a display string, falling back
 * rather than risking `[object Object]` (payloads are untyped
 * `Record<string, unknown>` — see notification-template.interface.ts).
 */
export function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}
