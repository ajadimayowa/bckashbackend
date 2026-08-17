import { Injectable, Logger } from '@nestjs/common';
import { ClientSession } from 'mongoose';

import { LedgerPostingPort } from '../interfaces/ledger-posting-port.interface';

/**
 * *** TEMPORARY — SEE PHASE_8_NOTES.md — MUST BE REPLACED IN PHASE 10 ***
 * Logs the call and does nothing else — no journal entry is actually posted.
 * Per the brief: "LedgerPostingPort's stub should simply log the call (no-op
 * otherwise) — Phase 10 (Accounting) will rebind it to actually post balanced
 * journal entries." Unlike NotificationPort's stub, this one deliberately does
 * NOT persist anything durable to replay later — Phase 10 is expected to
 * re-derive every historical disbursement/fee-collection directly from
 * Loan/MemberLoanAccount/FeePayment records (the source of truth already
 * exists there), not from a ledger-specific backlog table.
 */
@Injectable()
export class StubLedgerPostingPort implements LedgerPostingPort {
  private readonly logger = new Logger(StubLedgerPostingPort.name);

  postDisbursement(
    loanId: string,
    memberLoanAccountId: string,
    amountKobo: number,
    _session?: ClientSession,
  ): Promise<void> {
    this.logger.log(
      `[STUB] postDisbursement loanId=${loanId} memberLoanAccountId=${memberLoanAccountId} amountKobo=${amountKobo} — no journal entry posted (Phase 10 must rebind LEDGER_POSTING_PORT)`,
    );
    return Promise.resolve();
  }

  postFeeCollection(
    feePaymentId: string,
    amountKobo: number,
    _session?: ClientSession,
  ): Promise<void> {
    this.logger.log(
      `[STUB] postFeeCollection feePaymentId=${feePaymentId} amountKobo=${amountKobo} — no journal entry posted (Phase 10 must rebind LEDGER_POSTING_PORT)`,
    );
    return Promise.resolve();
  }
}
