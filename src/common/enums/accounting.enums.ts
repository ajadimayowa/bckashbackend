export enum AccountType {
  ASSET = 'ASSET',
  LIABILITY = 'LIABILITY',
  EQUITY = 'EQUITY',
  INCOME = 'INCOME',
  EXPENSE = 'EXPENSE',
}

/**
 * The business event that caused a JournalEntry to be posted — for traceability
 * back to source. This is a pre-existing Phase 1/2 placeholder, confirmed unused
 * anywhere before Phase 10 first consumed it (see PHASE_10_NOTES.md).
 *
 * Phase 10 (`modules/accounting`) is the first real consumer, using this exact
 * enum for `JournalEntry.sourceEntityType` — reusing it as-is rather than
 * introducing a duplicate narrower type. The brief's own literal type sketch
 * for `JournalEntry.sourceEntityType` is a 5-value union
 * (`LOAN_DISBURSEMENT | REPAYMENT | FEE_COLLECTION | PENALTY | MANUAL`); this
 * enum is a superset (also `EARLY_LIQUIDATION_FEE`/`BRANCH_FUNDING`, unused by
 * anything Phase 10 posts — a liquidation delay charge is categorized simply
 * as `PENALTY`, per Phase 9's own reuse decision) plus `MANUAL_ADJUSTMENT`
 * instead of a bare `MANUAL` for manual entries — same meaning, pre-existing
 * name kept rather than adding a synonym.
 */
export enum JournalSourceEvent {
  LOAN_DISBURSEMENT = 'LOAN_DISBURSEMENT',
  FEE_COLLECTION = 'FEE_COLLECTION',
  REPAYMENT = 'REPAYMENT',
  PENALTY = 'PENALTY',
  EARLY_LIQUIDATION_FEE = 'EARLY_LIQUIDATION_FEE',
  BRANCH_FUNDING = 'BRANCH_FUNDING',
  MANUAL_ADJUSTMENT = 'MANUAL_ADJUSTMENT',
}

/**
 * Which `Account` an automated posting debits/credits — stored as data
 * (`AccountMapping`), not hardcoded, so it's adjustable without a redeploy.
 * See `modules/accounting`'s default seed and PHASE_10_NOTES.md for the
 * mapping decisions (especially Penalty vs. Loans Receivable).
 */
export enum AccountMappingKey {
  DISBURSEMENT_DEBIT = 'DISBURSEMENT_DEBIT',
  DISBURSEMENT_CREDIT = 'DISBURSEMENT_CREDIT',
  REPAYMENT_DEBIT = 'REPAYMENT_DEBIT',
  REPAYMENT_CREDIT = 'REPAYMENT_CREDIT',
  FEE_COLLECTION_DEBIT = 'FEE_COLLECTION_DEBIT',
  FEE_COLLECTION_CREDIT = 'FEE_COLLECTION_CREDIT',
  PENALTY_DEBIT = 'PENALTY_DEBIT',
  PENALTY_CREDIT = 'PENALTY_CREDIT',
}
