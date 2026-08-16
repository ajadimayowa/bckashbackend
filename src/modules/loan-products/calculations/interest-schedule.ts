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
 * Standard flat-rate schedule: total interest = principal * annualRate *
 * (tenureMonths / 12), computed as a single multiply-then-divide (not a
 * sequence of separately-rounded steps) to minimize compounding
 * floating-point drift before the one rounding step. Principal and interest
 * are then split evenly across installments — the LAST installment absorbs
 * whatever remainder integer division left over, so the schedule always
 * sums to exactly `principal + totalInterest`, never off by a kobo.
 */
export function calculateFlatInterestSchedule(
  principalKobo: number,
  annualRateBasisPoints: number,
  tenureMonths: number,
): FlatScheduleResult {
  assertNonNegativeInteger(principalKobo, 'principalKobo');
  assertNonNegativeInteger(annualRateBasisPoints, 'annualRateBasisPoints');
  assertPositiveInteger(tenureMonths, 'tenureMonths');

  const totalInterestKobo = roundHalfUp(
    (principalKobo * annualRateBasisPoints * tenureMonths) / (10_000 * 12),
  );

  const basePrincipalPortion = Math.floor(principalKobo / tenureMonths);
  const baseInterestPortion = Math.floor(totalInterestKobo / tenureMonths);

  const schedule: FlatScheduleInstallment[] = [];
  let principalAllocated = 0;
  let interestAllocated = 0;

  for (let installmentNumber = 1; installmentNumber <= tenureMonths; installmentNumber += 1) {
    const isLast = installmentNumber === tenureMonths;
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
    // schedule[0] always exists — tenureMonths >= 1 is enforced above.
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
 * installment-over-installment as principal is paid down. The LAST
 * installment always pays off whatever balance actually remains (rather
 * than trusting the fixed EMI to land exactly on zero after N roundings),
 * so the schedule's principal portions always sum to exactly
 * `principalKobo` and the final closing balance is always exactly 0.
 */
export function calculateReducingBalanceSchedule(
  principalKobo: number,
  annualRateBasisPoints: number,
  tenureMonths: number,
): ReducingScheduleResult {
  assertNonNegativeInteger(principalKobo, 'principalKobo');
  assertNonNegativeInteger(annualRateBasisPoints, 'annualRateBasisPoints');
  assertPositiveInteger(tenureMonths, 'tenureMonths');

  const monthlyRate = annualRateBasisPoints / 10_000 / 12;

  let installmentAmountKobo: number;
  if (monthlyRate === 0) {
    installmentAmountKobo = roundHalfUp(principalKobo / tenureMonths);
  } else {
    const factor = Math.pow(1 + monthlyRate, tenureMonths);
    const emi = (principalKobo * monthlyRate * factor) / (factor - 1);
    installmentAmountKobo = roundHalfUp(emi);
  }

  const schedule: ReducingScheduleInstallment[] = [];
  let openingBalance = principalKobo;

  for (let installmentNumber = 1; installmentNumber <= tenureMonths; installmentNumber += 1) {
    const isLast = installmentNumber === tenureMonths;
    const interestPortion = roundHalfUp(openingBalance * monthlyRate);

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
