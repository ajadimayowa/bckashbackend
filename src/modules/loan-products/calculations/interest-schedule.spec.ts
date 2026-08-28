import {
  calculateFlatInterestSchedule,
  calculateReducingBalanceSchedule,
} from './interest-schedule';

describe('calculateFlatInterestSchedule', () => {
  it('computes total interest and splits principal/interest evenly for a tenure that divides evenly', () => {
    const result = calculateFlatInterestSchedule(365_000, 10_000, 10); // 100% flat, 10 days
    // 365000 * 10000 / 10000 = 365000 exactly — the full flat rate, not prorated by tenure.
    expect(result.totalInterestKobo).toBe(365_000);
    expect(result.installmentAmountKobo).toBe(73_000); // (365000/10) + (365000/10)
    expect(result.schedule).toHaveLength(10);
    for (const installment of result.schedule) {
      expect(installment.principalPortion).toBe(36_500);
      expect(installment.interestPortion).toBe(36_500);
      expect(installment.totalDue).toBe(73_000);
    }
  });

  it('sums exactly to principal + totalInterest for a tenure that does NOT divide evenly, absorbing remainder on the last installment', () => {
    const result = calculateFlatInterestSchedule(100_000, 1000, 3); // 10% flat, 3 days
    // 100000 * 1000 / 10000 = 10000 — the full 10%, regardless of the 3-day tenure.
    expect(result.totalInterestKobo).toBe(10_000);

    const sumPrincipal = result.schedule.reduce((acc, i) => acc + i.principalPortion, 0);
    const sumInterest = result.schedule.reduce((acc, i) => acc + i.interestPortion, 0);
    expect(sumPrincipal).toBe(100_000);
    expect(sumInterest).toBe(10_000);

    // First two installments get the floored base; the last absorbs the remainder.
    expect(result.schedule[0]!.principalPortion).toBe(33_333);
    expect(result.schedule[1]!.principalPortion).toBe(33_333);
    expect(result.schedule[2]!.principalPortion).toBe(33_334);
    expect(result.schedule[0]!.interestPortion).toBe(3_333);
    expect(result.schedule[1]!.interestPortion).toBe(3_333);
    expect(result.schedule[2]!.interestPortion).toBe(3_334);
  });

  it('handles a single-installment tenure', () => {
    const result = calculateFlatInterestSchedule(50_000, 500, 1); // 5% flat, 1 day
    expect(result.schedule).toHaveLength(1);
    expect(result.schedule[0]!.principalPortion).toBe(50_000);
    // 50000 * 500 / 10000 = 2500 — the full 5% of principal.
    expect(result.schedule[0]!.interestPortion).toBe(2_500);
    expect(result.installmentAmountKobo).toBe(result.schedule[0]!.totalDue);
  });

  it('sums exactly to principal + totalInterest across a range of tenures, including large principals', () => {
    const cases: Array<[number, number, number]> = [
      [1_000_000_00, 1_575, 6],
      [7_777_777, 999, 5],
      [3_333_333_33, 2_000, 24],
      [1, 10_000, 3],
    ];
    for (const [principal, rate, tenure] of cases) {
      const result = calculateFlatInterestSchedule(principal, rate, tenure);
      const sumPrincipal = result.schedule.reduce((acc, i) => acc + i.principalPortion, 0);
      const sumInterest = result.schedule.reduce((acc, i) => acc + i.interestPortion, 0);
      expect(sumPrincipal).toBe(principal);
      expect(sumInterest).toBe(result.totalInterestKobo);
      expect(sumPrincipal + sumInterest).toBe(principal + result.totalInterestKobo);
    }
  });

  it('a 0% rate produces zero interest but still splits principal correctly', () => {
    const result = calculateFlatInterestSchedule(90_000, 0, 3);
    expect(result.totalInterestKobo).toBe(0);
    for (const installment of result.schedule) {
      expect(installment.interestPortion).toBe(0);
    }
    expect(result.schedule.reduce((acc, i) => acc + i.principalPortion, 0)).toBe(90_000);
  });

  it('throws on tenureDays <= 0 (the zero-tenure edge guard)', () => {
    expect(() => calculateFlatInterestSchedule(100_000, 1000, 0)).toThrow(/positive integer/);
    expect(() => calculateFlatInterestSchedule(100_000, 1000, -1)).toThrow(/positive integer/);
  });

  it('throws on a non-integer tenureDays', () => {
    expect(() => calculateFlatInterestSchedule(100_000, 1000, 3.5)).toThrow(/positive integer/);
  });

  it('throws on negative or non-integer principal/rate', () => {
    expect(() => calculateFlatInterestSchedule(-1, 1000, 12)).toThrow(/non-negative integer/);
    expect(() => calculateFlatInterestSchedule(100_000, -1, 12)).toThrow(/non-negative integer/);
    expect(() => calculateFlatInterestSchedule(100_000.5, 1000, 12)).toThrow(
      /non-negative integer/,
    );
  });
});

describe('calculateReducingBalanceSchedule', () => {
  it('interest declines installment-over-installment as principal is paid down', () => {
    const { schedule } = calculateReducingBalanceSchedule(1_000_000, 1_800, 12); // 18% flat, 12 days
    for (let i = 1; i < schedule.length; i += 1) {
      expect(schedule[i]!.interestPortion).toBeLessThanOrEqual(schedule[i - 1]!.interestPortion);
    }
    // Strictly declining somewhere (not flat) — sanity check the rate isn't accidentally 0.
    expect(schedule[0]!.interestPortion).toBeGreaterThan(
      schedule[schedule.length - 1]!.interestPortion,
    );
  });

  it('opening/closing balances chain correctly and the schedule always sums exactly to principal (no rounding drift)', () => {
    const principal = 1_000_000;
    const { schedule } = calculateReducingBalanceSchedule(principal, 1_800, 12);

    let expectedOpening = principal;
    for (const installment of schedule) {
      expect(installment.openingBalance).toBe(expectedOpening);
      expect(installment.closingBalance).toBe(
        installment.openingBalance - installment.principalPortion,
      );
      expect(installment.totalDue).toBe(installment.principalPortion + installment.interestPortion);
      expectedOpening = installment.closingBalance;
    }
    // The loan is always fully paid off at the end — no kobo drift.
    expect(schedule[schedule.length - 1]!.closingBalance).toBe(0);

    const sumPrincipal = schedule.reduce((acc, i) => acc + i.principalPortion, 0);
    expect(sumPrincipal).toBe(principal);
  });

  it('sums exactly to principal across a range of tenures/rates, including ones that do not divide evenly', () => {
    const cases: Array<[number, number, number]> = [
      [1_000_000_00, 1_575, 7],
      [7_777_777, 999, 5],
      [3_333_333_33, 2_000, 24],
      [123_456, 50, 4],
    ];
    for (const [principal, rate, tenure] of cases) {
      const { schedule } = calculateReducingBalanceSchedule(principal, rate, tenure);
      const sumPrincipal = schedule.reduce((acc, i) => acc + i.principalPortion, 0);
      expect(sumPrincipal).toBe(principal);
      expect(schedule[schedule.length - 1]!.closingBalance).toBe(0);
    }
  });

  it('handles a single-installment tenure — the sole installment pays off the entire balance', () => {
    const { schedule } = calculateReducingBalanceSchedule(50_000, 1_200, 1);
    expect(schedule).toHaveLength(1);
    expect(schedule[0]!.principalPortion).toBe(50_000);
    expect(schedule[0]!.closingBalance).toBe(0);
  });

  it('a 0% rate produces zero interest every installment and splits principal evenly', () => {
    const { schedule } = calculateReducingBalanceSchedule(90_000, 0, 3);
    for (const installment of schedule) {
      expect(installment.interestPortion).toBe(0);
    }
    expect(schedule.reduce((acc, i) => acc + i.principalPortion, 0)).toBe(90_000);
    expect(schedule[schedule.length - 1]!.closingBalance).toBe(0);
  });

  it('throws on tenureDays <= 0', () => {
    expect(() => calculateReducingBalanceSchedule(100_000, 1000, 0)).toThrow(/positive integer/);
    expect(() => calculateReducingBalanceSchedule(100_000, 1000, -3)).toThrow(/positive integer/);
  });

  it('throws on negative or non-integer principal/rate', () => {
    expect(() => calculateReducingBalanceSchedule(-1, 1000, 12)).toThrow(/non-negative integer/);
    expect(() => calculateReducingBalanceSchedule(100_000, -1, 12)).toThrow(/non-negative integer/);
  });
});
