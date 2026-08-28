import { assertNonNegativeInteger, assertPositiveInteger, roundHalfUp } from './rounding.util';

export interface FlatScheduleInstallment {
  installmentNumber: number;
  dueDate?: Date;
  principalPortion: number;
  interestPortion: number;
  totalDue: number;
}

export interface FlatScheduleResult {
  /** The standard per-installment amount — every installment except (possibly) the last, which absorbs the rounding remainder. */
  installmentAmountKobo: number;
  totalInterestKobo: number;
  schedule: FlatScheduleInstallment[];
}

export interface ReducingScheduleInstallment {
  installmentNumber: number;
  openingBalance: number;
  interestPortion: number;
  principalPortion: number;
  closingBalance: number;
  totalDue: number;
}

export interface ReducingScheduleResult {
  schedule: ReducingScheduleInstallment[];
}

/**
 * Standard flat-rate schedule: total interest = principal * rate, charged in
 * full for the loan's tenure regardless of how many days that tenure is —
 * the configured product rate is a flat per-loan-cycle cost, not an annual
 * rate to be prorated down for a shorter tenure (a 15% product charges 15%
 * of principal whether the tenure picked is 14, 30, or 60 days). One entry
 * per repayment installment (`installmentCount` — the caller derives this
 * from the loan's tenure and `LoanProduct.repaymentPeriodDays`, e.g.
 * `ceil(tenureDays / 7)` for the default weekly cadence; this function
 * itself has no notion of days, only "how many installments") — principal
 * and interest are split evenly across them, the LAST installment absorbing
 * whatever remainder integer division left over, so the schedule always sums
 * to exactly `principal + totalInterest`, never off by a kobo.
 *
 * RENAMED from `tenureDays` (this function used to be called with one
 * installment per calendar day of tenure, i.e. `installmentCount ===
 * tenureDays` always) to `installmentCount` when weekly (multi-day)
 * installments were introduced — a pure parameter-name/doc change, the loop
 * below was already period-count-agnostic. See LoanVerificationService.disburse.
 */
export function calculateFlatInterestSchedule(
  principalKobo: number,
  rateBasisPoints: number,
  installmentCount: number,
): FlatScheduleResult {
  assertNonNegativeInteger(principalKobo, 'principalKobo');
  assertNonNegativeInteger(rateBasisPoints, 'rateBasisPoints');
  assertPositiveInteger(installmentCount, 'installmentCount');

  const totalInterestKobo = roundHalfUp((principalKobo * rateBasisPoints) / 10_000);

  const basePrincipalPortion = Math.floor(principalKobo / installmentCount);
  const baseInterestPortion = Math.floor(totalInterestKobo / installmentCount);

  const schedule: FlatScheduleInstallment[] = [];
  let principalAllocated = 0;
  let interestAllocated = 0;

  for (let installmentNumber = 1; installmentNumber <= installmentCount; installmentNumber += 1) {
    const isLast = installmentNumber === installmentCount;
    const principalPortion = isLast ? principalKobo - principalAllocated : basePrincipalPortion;
    const interestPortion = isLast ? totalInterestKobo - interestAllocated : baseInterestPortion;
    principalAllocated += principalPortion;
    interestAllocated += interestPortion;

    schedule.push({
      installmentNumber,
      principalPortion,
      interestPortion,
      totalDue: principalPortion + interestPortion,
    });
  }

  return {
    // schedule[0] always exists — installmentCount >= 1 is enforced above.
    installmentAmountKobo: schedule[0]!.totalDue,
    totalInterestKobo,
    schedule,
  };
}

/**
 * Standard reducing-balance amortization: a fixed EMI computed via the
 * compound-interest annuity formula (unavoidably floating-point — this is
 * how reducing-balance interest is defined — rounded once to the nearest
 * kobo), then each installment's interest is computed on the *remaining*
 * balance (not the original principal), so interest strictly declines
 * installment-over-installment as principal is paid down. One entry per
 * repayment installment (`installmentCount` — see calculateFlatInterestSchedule's
 * own doc comment for how the caller derives this from tenure + repayment
 * period). The LAST installment always pays off whatever balance actually
 * remains (rather than trusting the fixed EMI to land exactly on zero after N
 * roundings), so the schedule's principal portions always sum to exactly
 * `principalKobo` and the final closing balance is always exactly 0.
 *
 * Same "the configured rate is a flat per-tenure cost, not an annual one" as
 * calculateFlatInterestSchedule — the per-installment rate the compounding
 * formula needs is derived by spreading `rateBasisPoints` evenly across
 * `installmentCount` (not against a 365-day year), so a reducing-balance
 * loan's total interest benchmarks against the same flat product rate
 * (naturally landing below it, since reducing-balance is always cheaper than
 * flat by construction) regardless of which tenure/repayment-period was
 * picked.
 *
 * RENAMED from `tenureDays` to `installmentCount` alongside
 * calculateFlatInterestSchedule — see that function's own doc comment.
 */
export function calculateReducingBalanceSchedule(
  principalKobo: number,
  rateBasisPoints: number,
  installmentCount: number,
): ReducingScheduleResult {
  assertNonNegativeInteger(principalKobo, 'principalKobo');
  assertNonNegativeInteger(rateBasisPoints, 'rateBasisPoints');
  assertPositiveInteger(installmentCount, 'installmentCount');

  const perInstallmentRate = rateBasisPoints / 10_000 / installmentCount;

  let installmentAmountKobo: number;
  if (perInstallmentRate === 0) {
    installmentAmountKobo = roundHalfUp(principalKobo / installmentCount);
  } else {
    const factor = Math.pow(1 + perInstallmentRate, installmentCount);
    const emi = (principalKobo * perInstallmentRate * factor) / (factor - 1);
    installmentAmountKobo = roundHalfUp(emi);
  }

  const schedule: ReducingScheduleInstallment[] = [];
  let openingBalance = principalKobo;

  for (let installmentNumber = 1; installmentNumber <= installmentCount; installmentNumber += 1) {
    const isLast = installmentNumber === installmentCount;
    const interestPortion = roundHalfUp(openingBalance * perInstallmentRate);

    let principalPortion: number;
    let totalDue: number;
    if (isLast) {
      principalPortion = openingBalance;
      totalDue = principalPortion + interestPortion;
    } else {
      totalDue = installmentAmountKobo;
      principalPortion = totalDue - interestPortion;
      // Pathological input guard (very high rate / very short tenure could
      // round the EMI below the interest due) — never let a single
      // installment "pay negative principal"; any discrepancy still gets
      // absorbed by the last installment's exact-payoff behavior above.
      if (principalPortion < 0) {
        principalPortion = 0;
      }
    }

    const closingBalance = openingBalance - principalPortion;
    schedule.push({
      installmentNumber,
      openingBalance,
      interestPortion,
      principalPortion,
      closingBalance,
      totalDue,
    });
    openingBalance = closingBalance;
  }

  return { schedule };
}
