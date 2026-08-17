import { Injectable, Logger } from '@nestjs/common';
import { ClientSession } from 'mongoose';

import {
  LedgerPostingPort,
  PostDisbursementParams,
  PostedJournalEntry,
  PostFeeCollectionParams,
  PostPenaltyParams,
  PostRepaymentParams,
} from '../interfaces/ledger-posting-port.interface';

/**
 * *** RETAINED FOR TESTS ONLY — SEE PHASE_10_NOTES.md ***
 * `LEDGER_POSTING_PORT` is now bound to `AccountingModule`'s real
 * `LedgerPostingService` in production (`loans.module.ts`); this stub
 * remains only as a lightweight double for tests that don't need real
 * postings. Never persists anything — fabricates a `PostedJournalEntry`-
 * shaped return value so callers that inspect the result don't need a
 * special case for "the stub is bound."
 */
@Injectable()
export class StubLedgerPostingPort implements LedgerPostingPort {
  private readonly logger = new Logger(StubLedgerPostingPort.name);

  postDisbursement(
    params: PostDisbursementParams,
    _session?: ClientSession,
  ): Promise<PostedJournalEntry> {
    this.logger.log(
      `[STUB] postDisbursement loanId=${params.loanId} memberLoanAccountId=${params.memberLoanAccountId} amountKobo=${params.amountKobo} — no journal entry posted`,
    );
    return Promise.resolve(
      this.fabricate('LOAN_DISBURSEMENT', params.loanId, params.branchId, params.amountKobo),
    );
  }

  postFeeCollection(
    params: PostFeeCollectionParams,
    _session?: ClientSession,
  ): Promise<PostedJournalEntry> {
    this.logger.log(
      `[STUB] postFeeCollection feePaymentId=${params.feePaymentId} amountKobo=${params.amountKobo} — no journal entry posted`,
    );
    return Promise.resolve(
      this.fabricate('FEE_COLLECTION', params.feePaymentId, params.branchId, params.amountKobo),
    );
  }

  postRepayment(
    params: PostRepaymentParams,
    _session?: ClientSession,
  ): Promise<PostedJournalEntry> {
    this.logger.log(
      `[STUB] postRepayment repaymentRecordId=${params.repaymentRecordId} amountKobo=${params.amountKobo} — no journal entry posted`,
    );
    return Promise.resolve(
      this.fabricate('REPAYMENT', params.repaymentRecordId, params.branchId, params.amountKobo),
    );
  }

  postPenalty(params: PostPenaltyParams, _session?: ClientSession): Promise<PostedJournalEntry> {
    this.logger.log(
      `[STUB] postPenalty sourceEntityType=${params.sourceEntityType} sourceEntityId=${params.sourceEntityId} amountKobo=${params.amountKobo} — no journal entry posted`,
    );
    return Promise.resolve(
      this.fabricate(
        'PENALTY',
        params.sourceEntityId,
        params.branchId,
        params.amountKobo,
        params.sourceEntityType,
      ),
    );
  }

  private fabricate(
    sourceEntityType: string,
    sourceEntityId: string,
    branchId: string,
    amountKobo: number,
    sourceRefPrefix?: string,
  ): PostedJournalEntry {
    const now = new Date();
    return {
      id: `stub-${sourceEntityType}-${sourceEntityId}`,
      sourceEntityType,
      sourceEntityId,
      sourceRef: `${sourceRefPrefix ?? sourceEntityType}:${sourceEntityId}`,
      branchId,
      date: now,
      lines: [{ accountId: 'stub', debitKobo: amountKobo, creditKobo: amountKobo }],
      postedAt: now,
    };
  }
}
