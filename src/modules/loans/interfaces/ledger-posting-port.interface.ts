import { ClientSession } from 'mongoose';

export const LEDGER_POSTING_PORT = Symbol('LEDGER_POSTING_PORT');

/**
 * *** RECONCILED IN PHASE 10 — SEE PHASE_9_NOTES.md / PHASE_10_NOTES.md ***
 *
 * Phase 8 defined `postDisbursement`/`postFeeCollection`, Phase 9 added
 * `postRepayment`/`postPenalty` — all four as loosely-typed positional-arg
 * stubs, since no real implementation existed yet to hold the signature
 * accountable. Phase 10 (Accounting) is the real implementation, and
 * finalizes the shape here:
 *   - every method now takes a single params object (room to grow without
 *     more positional-arg churn) and an explicit `branchId` (every
 *     `JournalEntry` needs one; Phase 8/9 call sites always had it available
 *     but weren't yet passing it through);
 *   - every method now returns the `JournalEntry` it posted (or the
 *     pre-existing one, on an idempotent no-op) instead of `void`, so a
 *     caller can reference it if needed — see `PostedJournalEntry` below,
 *     deliberately a small structural type rather than importing
 *     accounting's own Mongoose document type here (this port is defined in
 *     `modules/loans` but implemented in `modules/accounting`; the port
 *     itself should not need to know its implementor's persistence-layer
 *     document shape — see PHASE_10_NOTES.md);
 *   - `postPenalty` now takes an explicit `sourceEntityType` distinguishing
 *     `PENALTY_CHARGE` from `LIQUIDATION_DELAY_CHARGE` — both post as a
 *     `JournalEntry` in the same "PENALTY" category (reusing this one
 *     method, per Phase 9's own reasoning: a delay charge is functionally a
 *     penalty), but the underlying source documents live in different
 *     collections and must never collide on `sourceRef`.
 *
 * Every id field is a `string`, not `ObjectId` — consistent with every other
 * port in this codebase (`BvnVerificationAdapter`, `S3Adapter`,
 * `FaceComparisonAdapter`, ...), which never carry a raw Mongoose type across
 * a module/port boundary.
 *
 * **`session` is accepted but NOT nested into by the real implementation** —
 * a deliberate, reasoned deviation from what the parameter's presence might
 * suggest, discovered while implementing `LedgerPostingService.postIdempotent`:
 * MongoDB aborts an entire multi-document transaction on the first write
 * error, and a session in that state cannot be used for a graceful "catch
 * the duplicate-key error and re-fetch the winner" recovery (the very
 * mechanism the idempotency guarantee depends on) — a poisoned session can't
 * even perform a plain read afterward. Composing the ledger post into the
 * *caller's* transaction is therefore fundamentally incompatible with safe
 * idempotent-no-op recovery when a race is lost. `LedgerPostingService`
 * instead runs its own independently-managed session for every posting —
 * the caller's own transaction (balance decrement, etc.) still aborts
 * correctly if the ledger post throws for a genuine (non-duplicate) reason,
 * but the two are two separate atomic units, not one. See PHASE_10_NOTES.md
 * for the full reasoning and the accepted trade-off (a vanishingly rare
 * crash-between-two-independent-commits window).
 *
 * `AccountingModule`'s `LedgerPostingService` is the real implementation —
 * see that module for the idempotent-posting mechanics. `StubLedgerPostingPort`
 * (still used only by tests that don't need real postings) fabricates a
 * `PostedJournalEntry`-shaped return value without persisting anything.
 */
export interface PostedJournalEntryLine {
  accountId: string;
  debitKobo?: number;
  creditKobo?: number;
}

export interface PostedJournalEntry {
  id: string;
  sourceEntityType: string;
  sourceEntityId: string;
  sourceRef: string;
  branchId: string;
  date: Date;
  lines: PostedJournalEntryLine[];
  postedAt: Date;
}

export interface PostDisbursementParams {
  loanId: string;
  memberLoanAccountId: string;
  amountKobo: number;
  branchId: string;
}

export interface PostFeeCollectionParams {
  feePaymentId: string;
  amountKobo: number;
  branchId: string;
}

export interface PostRepaymentParams {
  repaymentRecordId: string;
  amountKobo: number;
  branchId: string;
}

export type PenaltySourceEntityType = 'PENALTY_CHARGE' | 'LIQUIDATION_DELAY_CHARGE';

export interface PostPenaltyParams {
  sourceEntityType: PenaltySourceEntityType;
  sourceEntityId: string;
  amountKobo: number;
  branchId: string;
}

export interface LedgerPostingPort {
  postDisbursement(
    params: PostDisbursementParams,
    session?: ClientSession,
  ): Promise<PostedJournalEntry>;
  postFeeCollection(
    params: PostFeeCollectionParams,
    session?: ClientSession,
  ): Promise<PostedJournalEntry>;
  postRepayment(params: PostRepaymentParams, session?: ClientSession): Promise<PostedJournalEntry>;
  postPenalty(params: PostPenaltyParams, session?: ClientSession): Promise<PostedJournalEntry>;
}
