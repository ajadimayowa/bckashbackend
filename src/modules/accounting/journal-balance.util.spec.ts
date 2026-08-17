import { BadRequestException } from '@nestjs/common';

import { assertJournalLinesBalanced } from './journal-balance.util';

describe('assertJournalLinesBalanced', () => {
  it('accepts a balanced two-line entry', () => {
    expect(() =>
      assertJournalLinesBalanced([
        { accountId: 'a', debitKobo: 1_000 },
        { accountId: 'b', creditKobo: 1_000 },
      ]),
    ).not.toThrow();
  });

  it('accepts a balanced multi-line entry (multiple debits, one credit)', () => {
    expect(() =>
      assertJournalLinesBalanced([
        { accountId: 'a', debitKobo: 600 },
        { accountId: 'b', debitKobo: 400 },
        { accountId: 'c', creditKobo: 1_000 },
      ]),
    ).not.toThrow();
  });

  it('rejects an unbalanced entry (Σdebit !== Σcredit) — the load-bearing integrity check', () => {
    expect(() =>
      assertJournalLinesBalanced([
        { accountId: 'a', debitKobo: 1_000 },
        { accountId: 'b', creditKobo: 900 },
      ]),
    ).toThrow(BadRequestException);
  });

  it('rejects a line with both debitKobo and creditKobo set', () => {
    expect(() =>
      assertJournalLinesBalanced([
        { accountId: 'a', debitKobo: 500, creditKobo: 500 },
        { accountId: 'b', creditKobo: 500 },
      ]),
    ).toThrow(/exactly one of debitKobo\/creditKobo/);
  });

  it('rejects a line with neither debitKobo nor creditKobo set', () => {
    expect(() =>
      assertJournalLinesBalanced([{ accountId: 'a' }, { accountId: 'b', creditKobo: 0 }]),
    ).toThrow(/exactly one of debitKobo\/creditKobo/);
  });

  it('rejects an empty lines array', () => {
    expect(() => assertJournalLinesBalanced([])).toThrow(/at least one line/);
  });
});
