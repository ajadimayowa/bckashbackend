import { FeeCalcType, FeePercentageBasis } from '../../../common/enums/loan-product.enums';
import { calculateEarlyLiquidationFee, calculateFeeAmount } from './fee-calculation';

describe('calculateFeeAmount', () => {
  it('FIXED returns the exact value, ignoring context entirely', () => {
    const fee = { calcType: FeeCalcType.FIXED, value: 500_00 };
    expect(calculateFeeAmount(fee, {})).toBe(500_00);
    expect(calculateFeeAmount(fee, { principal: 1, outstanding: 2, overdueAmount: 3 })).toBe(
      500_00,
    );
  });

  it('PERCENTAGE against principal computes basis-points math correctly', () => {
    const fee = {
      calcType: FeeCalcType.PERCENTAGE,
      value: 1000, // 10.00%
      percentageOf: FeePercentageBasis.PRINCIPAL,
    };
    expect(calculateFeeAmount(fee, { principal: 100_000 })).toBe(10_000);
  });

  it('PERCENTAGE against outstanding computes correctly', () => {
    const fee = {
      calcType: FeeCalcType.PERCENTAGE,
      value: 250, // 2.50%
      percentageOf: FeePercentageBasis.OUTSTANDING,
    };
    expect(calculateFeeAmount(fee, { outstanding: 200_000 })).toBe(5_000);
  });

  it('PERCENTAGE against overdueAmount computes correctly', () => {
    const fee = {
      calcType: FeeCalcType.PERCENTAGE,
      value: 500, // 5.00%
      percentageOf: FeePercentageBasis.OVERDUE_AMOUNT,
    };
    expect(calculateFeeAmount(fee, { overdueAmount: 40_000 })).toBe(2_000);
  });

  it('rounds half up at the .5 boundary', () => {
    const fee = {
      calcType: FeeCalcType.PERCENTAGE,
      value: 25, // 0.25%
      percentageOf: FeePercentageBasis.PRINCIPAL,
    };
    // 200 * 25 / 10_000 = 0.5 -> rounds up to 1
    expect(calculateFeeAmount(fee, { principal: 200 })).toBe(1);
  });

  it('throws when the required context field for percentageOf is missing', () => {
    const fee = {
      calcType: FeeCalcType.PERCENTAGE,
      value: 1000,
      percentageOf: FeePercentageBasis.OUTSTANDING,
    };
    expect(() => calculateFeeAmount(fee, { principal: 100_000 })).toThrow(/outstanding/);
  });

  it('throws when calcType is PERCENTAGE but percentageOf is unset', () => {
    const fee = { calcType: FeeCalcType.PERCENTAGE, value: 1000 };
    expect(() => calculateFeeAmount(fee, { principal: 100_000 })).toThrow(/percentageOf/);
  });

  it('throws on a negative fee.value', () => {
    const fee = { calcType: FeeCalcType.FIXED, value: -1 };
    expect(() => calculateFeeAmount(fee, {})).toThrow(/non-negative integer/);
  });

  it('throws on a non-integer fee.value', () => {
    const fee = { calcType: FeeCalcType.FIXED, value: 10.5 };
    expect(() => calculateFeeAmount(fee, {})).toThrow(/non-negative integer/);
  });

  it('throws on a negative context value', () => {
    const fee = {
      calcType: FeeCalcType.PERCENTAGE,
      value: 1000,
      percentageOf: FeePercentageBasis.PRINCIPAL,
    };
    expect(() => calculateFeeAmount(fee, { principal: -5 })).toThrow(/non-negative integer/);
  });

  it('throws on a non-integer context value', () => {
    const fee = {
      calcType: FeeCalcType.PERCENTAGE,
      value: 1000,
      percentageOf: FeePercentageBasis.PRINCIPAL,
    };
    expect(() => calculateFeeAmount(fee, { principal: 5.5 })).toThrow(/non-negative integer/);
  });
});

describe('calculateEarlyLiquidationFee', () => {
  it('FIXED early liquidation fee ignores outstanding balance', () => {
    const fee = { calcType: FeeCalcType.FIXED, value: 2_000 };
    expect(calculateEarlyLiquidationFee(fee, 1)).toBe(2_000);
    expect(calculateEarlyLiquidationFee(fee, 10_000_000)).toBe(2_000);
  });

  it('PERCENTAGE early liquidation fee scales with outstanding balance across a range', () => {
    const fee = {
      calcType: FeeCalcType.PERCENTAGE,
      value: 200, // 2.00%
      percentageOf: FeePercentageBasis.OUTSTANDING,
    };
    expect(calculateEarlyLiquidationFee(fee, 0)).toBe(0);
    expect(calculateEarlyLiquidationFee(fee, 50_000)).toBe(1_000);
    expect(calculateEarlyLiquidationFee(fee, 1_000_000)).toBe(20_000);
  });

  it('throws on a negative outstanding balance', () => {
    const fee = { calcType: FeeCalcType.FIXED, value: 100 };
    expect(() => calculateEarlyLiquidationFee(fee, -1)).toThrow(/non-negative integer/);
  });
});
