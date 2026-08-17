import { ClientSession } from 'mongoose';

export const LEDGER_POSTING_PORT = Symbol('LEDGER_POSTING_PORT');

/**
 * *** TEMPORARY PORT — SEE PHASE_8_NOTES.md / PHASE_9_NOTES.md — MUST BE
 * REBOUND IN PHASE 10 ***
 *
 * Every money-movement event must post balanced double-entry journal entries,
 * but the Accounting module doesn't exist until Phase 10. This port lets
 * Loans/Repayments depend on "post this movement to the ledger" without
 * depending on Accounting directly — same pattern as Phase 6's LoanStatusPort.
 * `loans.module.ts` currently binds this to `StubLedgerPostingPort`, which only
 * logs the call (see that class's own doc comment) — Phase 10 MUST replace this
 * binding with a real implementation that actually posts journal entries, or
 * every disbursement/fee-collection/repayment/penalty will silently go
 * unrecorded in the ledger. See PHASE_9_NOTES.md for the full list of methods
 * awaiting a real implementation.
 *
 * Every method accepts an optional Mongo `session` so a real implementation
 * can be composed into the same transaction as the underlying balance change
 * — the stub ignores it.
 *
 * `postRepayment`/`postPenalty` added in Phase 9 (`modules/repayments`).
 * `postPenalty` is deliberately reused for BOTH an overdue-installment
 * penalty charge AND an early-liquidation recurring delay charge — a delay
 * charge is functionally a penalty, just scoped to a liquidation request
 * instead of a schedule installment; see PHASE_9_NOTES.md rather than adding
 * a near-duplicate method.
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
  postRepayment(repaymentId: string, amountKobo: number, session?: ClientSession): Promise<void>;
  postPenalty(penaltyChargeId: string, amountKobo: number, session?: ClientSession): Promise<void>;
}
