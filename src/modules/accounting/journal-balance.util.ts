import { BadRequestException } from '@nestjs/common';

export interface JournalLineLike {
  accountId: string;
  debitKobo?: number | null;
  creditKobo?: number | null;
}

/**
 * The fundamental integrity guarantee of double-entry bookkeeping — Σdebit
 * must exactly equal Σcredit, and every line must set exactly one of
 * debit/credit, never both, never neither. Shared by `LedgerPostingService`
 * (automated postings) and `ManualJournalEntryService` (manual proposals) so
 * this rule is enforced identically, and only once, everywhere a
 * `JournalEntry` can originate. Called BEFORE any DB access — an unbalanced
 * entry must never reach the database, let alone a workflow proposal.
 */
export function assertJournalLinesBalanced(lines: JournalLineLike[]): void {
  if (lines.length === 0) {
    throw new BadRequestException('A journal entry must have at least one line');
  }

  let totalDebit = 0;
  let totalCredit = 0;
  for (const line of lines) {
    const hasDebit = line.debitKobo !== undefined && line.debitKobo !== null;
    const hasCredit = line.creditKobo !== undefined && line.creditKobo !== null;
    if (hasDebit === hasCredit) {
      throw new BadRequestException(
        `Each journal entry line must set exactly one of debitKobo/creditKobo (accountId=${line.accountId})`,
      );
    }
    totalDebit += line.debitKobo ?? 0;
    totalCredit += line.creditKobo ?? 0;
  }

  if (totalDebit !== totalCredit) {
    throw new BadRequestException(
      `Unbalanced journal entry: total debit (${totalDebit}) !== total credit (${totalCredit})`,
    );
  }
}
