import { FeeCalcType, PenaltyPercentageBasis } from '../../../common/enums/loan-product.enums';
import { calculatePenaltyAmount } from './penalty-calculation';

describe('calculatePenaltyAmount', () => {
  const fixedRule = { calcType: FeeCalcType.FIXED, value: 1_500, gracePeriodDays: 5 };
  const overdueAmountRule = {
    calcType: FeeCalcType.PERCENTAGE,
    value: 500, // 5.00%
    percentageOf: PenaltyPercentageBasis.OVERDUE_AMOUNT,
    gracePeriodDays: 5,
  };
  const outstandingRule = {
    calcType: FeeCalcType.PERCENTAGE,
    value: 500,
    percentageOf: PenaltyPercentageBasis.OUTSTANDING,
    gracePeriodDays: 5,
  };
  const principalRule = {
    calcType: FeeCalcType.PERCENTAGE,
    value: 500,
    percentageOf: PenaltyPercentageBasis.PRINCIPAL,
    gracePeriodDays: 5,
  };

  it('is zero for any daysLate strictly within the grace period', () => {
    expect(calculatePenaltyAmount(fixedRule, {}, 0)).toBe(0);
    expect(calculatePenaltyAmount(fixedRule, {}, 3)).toBe(0);
  });

  it('is zero exactly at the gracePeriodDays boundary (inclusive)', () => {
    expect(calculatePenaltyAmount(fixedRule, {}, 5)).toBe(0);
  });

  it('applies the penalty starting the first day beyond the grace period', () => {
    expect(calculatePenaltyAmount(fixedRule, {}, 6)).toBe(1_500);
  });

  it('FIXED penalty returns the exact value regardless of context', () => {
    expect(calculatePenaltyAmount(fixedRule, { overdueAmountKobo: 1 }, 10)).toBe(1_500);
    expect(calculatePenaltyAmount(fixedRule, { overdueAmountKobo: 10_000_000 }, 10)).toBe(1_500);
  });

  it('PERCENTAGE/OVERDUE_AMOUNT computes basis-points math against context.overdueAmountKobo', () => {
    expect(calculatePenaltyAmount(overdueAmountRule, { overdueAmountKobo: 200_000 }, 10)).toBe(
      10_000,
    );
  });

  it('PERCENTAGE/OUTSTANDING computes against context.outstandingBalanceKobo', () => {
    expect(calculatePenaltyAmount(outstandingRule, { outstandingBalanceKobo: 400_000 }, 10)).toBe(
      20_000,
    );
  });

  it('PERCENTAGE/PRINCIPAL computes against context.principalKobo — added in Phase 9, see PenaltyPercentageBasis', () => {
    expect(calculatePenaltyAmount(principalRule, { principalKobo: 1_000_000 }, 10)).toBe(50_000);
  });

  it('PERCENTAGE penalty is zero when the relevant context amount is zero, even beyond grace', () => {
    expect(calculatePenaltyAmount(overdueAmountRule, { overdueAmountKobo: 0 }, 10)).toBe(0);
  });

  it('throws when the context field matching percentageOf is missing', () => {
    expect(() =>
      calculatePenaltyAmount(outstandingRule, { overdueAmountKobo: 200_000 }, 10),
    ).toThrow(/context\.outstandingBalanceKobo/);
  });

  it('throws when calcType is PERCENTAGE but percentageOf is unset', () => {
    const badRule = { calcType: FeeCalcType.PERCENTAGE, value: 500, gracePeriodDays: 5 };
    expect(() => calculatePenaltyAmount(badRule, { overdueAmountKobo: 100_000 }, 10)).toThrow(
      /percentageOf/,
    );
  });

  it('does not throw for a missing percentageOf while still within grace (short-circuits before validating it)', () => {
    const badRule = { calcType: FeeCalcType.PERCENTAGE, value: 500, gracePeriodDays: 5 };
    expect(calculatePenaltyAmount(badRule, {}, 5)).toBe(0);
  });

  it('throws on a negative or non-integer daysLate', () => {
    expect(() => calculatePenaltyAmount(fixedRule, {}, -1)).toThrow(/non-negative integer/);
    expect(() => calculatePenaltyAmount(fixedRule, {}, 3.5)).toThrow(/non-negative integer/);
  });

  it('throws on a negative penaltyRule.value', () => {
    const badRule = { calcType: FeeCalcType.FIXED, value: -1, gracePeriodDays: 5 };
    expect(() => calculatePenaltyAmount(badRule, {}, 10)).toThrow(/non-negative integer/);
  });

  it('throws on a negative context amount', () => {
    expect(() => calculatePenaltyAmount(overdueAmountRule, { overdueAmountKobo: -1 }, 10)).toThrow(
      /non-negative integer/,
    );
  });
});
