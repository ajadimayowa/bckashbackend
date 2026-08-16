export enum InterestType {
  FLAT = 'FLAT',
  REDUCING = 'REDUCING',
}

export enum PenaltyRuleType {
  FIXED = 'FIXED',
  PERCENTAGE = 'PERCENTAGE',
}

export enum FeeCategory {
  REGISTRATION = 'REGISTRATION',
  FORM = 'FORM',
  MEMBERSHIP = 'MEMBERSHIP',
  LATE_REPAYMENT = 'LATE_REPAYMENT',
  EARLY_LIQUIDATION = 'EARLY_LIQUIDATION',
  OTHER = 'OTHER',
}

export enum FeeTiming {
  PRE_LOAN = 'PRE_LOAN',
  DURING_LIFECYCLE = 'DURING_LIFECYCLE',
}

export enum FeeCalculationType {
  FIXED = 'FIXED',
  PERCENTAGE = 'PERCENTAGE',
}

/** What a PERCENTAGE fee's rate applies against — only meaningful when calculationType is PERCENTAGE. */
export enum FeePercentageOfTarget {
  PRINCIPAL = 'PRINCIPAL',
  OUTSTANDING_BALANCE = 'OUTSTANDING_BALANCE',
  OVERDUE_INSTALLMENT = 'OVERDUE_INSTALLMENT',
}
