/**
 * Adds `days` calendar days to `date` — plain, unambiguous arithmetic (no
 * month-length clamping needed, unlike `addMonths`). Used by
 * `LoanVerificationService` to derive each repayment schedule installment's
 * `dueDate` from the disbursement (or, for CHEQUE_PICKUP, the cheque
 * handover) date — `installmentNumber * LoanProduct.repaymentPeriodDays`
 * days later (7 for the default weekly cadence), with the final installment
 * clamped to exactly `tenureDays` after the anchor rather than overshooting
 * it. See `normalizeSchedule`/`confirmChequeHandover`.
 */
export function addDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setDate(result.getDate() + days);
  return result;
}
