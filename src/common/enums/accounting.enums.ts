export enum AccountType {
  ASSET = 'ASSET',
  LIABILITY = 'LIABILITY',
  EQUITY = 'EQUITY',
  INCOME = 'INCOME',
  EXPENSE = 'EXPENSE',
}

/** The business event that caused a JournalEntry to be posted — for traceability back to source. */
export enum JournalSourceEvent {
  LOAN_DISBURSEMENT = 'LOAN_DISBURSEMENT',
  FEE_COLLECTION = 'FEE_COLLECTION',
  REPAYMENT = 'REPAYMENT',
  PENALTY = 'PENALTY',
  EARLY_LIQUIDATION_FEE = 'EARLY_LIQUIDATION_FEE',
  BRANCH_FUNDING = 'BRANCH_FUNDING',
  MANUAL_ADJUSTMENT = 'MANUAL_ADJUSTMENT',
}
