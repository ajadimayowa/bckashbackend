import { FeeCalcType, PenaltyPercentageBasis } from '../../../common/enums/loan-product.enums';
import { calculatePenaltyAmount } from './penalty-calculation';

describe('calculatePenaltyAmount', () => {
  const fixedRule = { calcType: FeeCalcType.FIXED, value: 1_500, gracePeriodDays: 5 };
  const percentageRule = {
    calcType: FeeCalcType.PERCENTAGE,
    value: 500, // 5.00%
    percentageOf: PenaltyPercentageBasis.OVERDUE_AMOUNT,
    gracePeriodDays: 5,
  };

  it('is zero for any daysLate strictly within the grace period', () => {
    expect(calculatePenaltyAmount(fixedRule, 100_000, 0)).toBe(0);
    expect(calculatePenaltyAmount(fixedRule, 100_000, 3)).toBe(0);
  });

  it('is zero exactly at the gracePeriodDays boundary (inclusive)', () => {
    expect(calculatePenaltyAmount(fixedRule, 100_000, 5)).toBe(0);
  });

  it('applies the penalty starting the first day beyond the grace period', () => {
    expect(calculatePenaltyAmount(fixedRule, 100_000, 6)).toBe(1_500);
  });

  it('FIXED penalty returns the exact value regardless of overdueAmountKobo', () => {
    expect(calculatePenaltyAmount(fixedRule, 1, 10)).toBe(1_500);
    expect(calculatePenaltyAmount(fixedRule, 10_000_000, 10)).toBe(1_500);
  });

  it('PERCENTAGE penalty computes basis-points math against overdueAmountKobo', () => {
    expect(calculatePenaltyAmount(percentageRule, 200_000, 10)).toBe(10_000);
  });

  it('PERCENTAGE penalty is zero when overdueAmountKobo is zero, even beyond grace', () => {
    expect(calculatePenaltyAmount(percentageRule, 0, 10)).toBe(0);
  });

  it('throws when calcType is PERCENTAGE but percentageOf is unset', () => {
    const badRule = { calcType: FeeCalcType.PERCENTAGE, value: 500, gracePeriodDays: 5 };
    expect(() => calculatePenaltyAmount(badRule, 100_000, 10)).toThrow(/percentageOf/);
  });

  it('does not throw for a missing percentageOf while still within grace (short-circuits before validating it)', () => {
    const badRule = { calcType: FeeCalcType.PERCENTAGE, value: 500, gracePeriodDays: 5 };
    expect(calculatePenaltyAmount(badRule, 100_000, 5)).toBe(0);
  });

  it('throws on a negative overdueAmountKobo', () => {
    expect(() => calculatePenaltyAmount(fixedRule, -1, 10)).toThrow(/non-negative integer/);
  });

  it('throws on a negative or non-integer daysLate', () => {
    expect(() => calculatePenaltyAmount(fixedRule, 100_000, -1)).toThrow(/non-negative integer/);
    expect(() => calculatePenaltyAmount(fixedRule, 100_000, 3.5)).toThrow(/non-negative integer/);
  });

  it('throws on a negative penaltyRule.value', () => {
    const badRule = { calcType: FeeCalcType.FIXED, value: -1, gracePeriodDays: 5 };
    expect(() => calculatePenaltyAmount(badRule, 100_000, 10)).toThrow(/non-negative integer/);
  });
});
