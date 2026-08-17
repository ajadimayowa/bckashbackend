import { ClientSession } from 'mongoose';

export const LEDGER_POSTING_PORT = Symbol('LEDGER_POSTING_PORT');

/**
 * *** TEMPORARY PORT — SEE PHASE_8_NOTES.md — MUST BE REBOUND IN PHASE 10 ***
 *
 * Disbursement/fee-collection must post balanced double-entry journal entries,
 * but the Accounting module doesn't exist until Phase 10. This port lets
 * LoanVerificationService depend on "post this movement to the ledger" without
 * depending on Accounting directly — same pattern as Phase 6's LoanStatusPort.
 * `loans.module.ts` currently binds this to `StubLedgerPostingPort`, which only
 * logs the call (see that class's own doc comment) — Phase 10 MUST replace this
 * binding with a real implementation that actually posts journal entries, or
 * every disbursement/fee-collection will silently go unrecorded in the ledger.
 *
 * Both methods accept an optional Mongo `session` so a real implementation can
 * be composed into the same transaction as the disbursement itself
 * (`LoanVerificationService`'s disbursement transaction) — the stub ignores it.
 */
export interface LedgerPostingPort {
  postDisbursement(
    loanId: string,
    memberLoanAccountId: string,
    amountKobo: number,
    session?: ClientSession,
  ): Promise<void>;
  postFeeCollection(
    feePaymentId: string,
    amountKobo: number,
    session?: ClientSession,
  ): Promise<void>;
}
