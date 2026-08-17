/**
 * Adds `months` calendar months to `date`, clamping to the last day of the
 * target month rather than letting it roll into the following month — e.g.
 * Jan 31 + 1 month = Feb 28 (or 29 in a leap year), not Mar 3, which is what
 * naive `Date.setMonth` arithmetic would silently produce. Used by
 * `LoanVerificationService` to derive each repayment schedule installment's
 * `dueDate` from the disbursement date (Phase 9 — see PHASE_9_NOTES.md;
 * Phase 8 didn't need real calendar dates and left this uncomputed).
 */
export function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const originalDay = result.getDate();

  result.setDate(1); // avoid month-overflow artifacts while shifting the month itself
  result.setMonth(result.getMonth() + months);

  const daysInTargetMonth = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  result.setDate(Math.min(originalDay, daysInTargetMonth));

  return result;
}
