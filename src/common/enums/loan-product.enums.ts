/**
 * Numeric conventions used throughout this module (and everywhere a
 * FeeDefinition/LoanProduct value is read) — see PHASE_7_NOTES.md:
 *
 * - Money is always integer **kobo**, never a float, matching the
 *   project-wide convention.
 * - Rates and percentage-fee `value`s are always integer **basis points**
 *   (1 bp = 0.01%), e.g. `1500` = 15.00%, `250` = 2.50%. `FeeDefinition.value`
 *   / `LoanProduct.interestRate` / `penaltyRule.value` all follow this —
 *   `1500` never means "15" flat, it means "15.00%". Every field using this
 *   convention is documented at its own declaration too, since it's an easy
 *   thing for a future reader to get wrong.
 */

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

export enum FeeCalcType {
  FIXED = 'FIXED',
  PERCENTAGE = 'PERCENTAGE',
}

export enum FeePercentageBasis {
  PRINCIPAL = 'PRINCIPAL',
  OUTSTANDING = 'OUTSTANDING',
  OVERDUE_AMOUNT = 'OVERDUE_AMOUNT',
}

/**
 * ASSUMPTION (flagged, see PHASE_7_NOTES.md — confirm before relying on
 * this): whether a fee is charged once per group or once per member is an
 * explicit, admin-set field per FeeDefinition rather than inferred from
 * `category`, so the coop can configure it either way. The defaults this
 * phase pre-fills at the DTO layer (not enforced by the schema) are
 * documented in PHASE_7_NOTES.md.
 */
export enum FeeAppliesTo {
  PER_MEMBER = 'PER_MEMBER',
  PER_GROUP = 'PER_GROUP',
}

/** Percentage bases a *penalty* can be computed against — never PRINCIPAL (a loan already exists by the time a penalty applies). */
export enum PenaltyPercentageBasis {
  OUTSTANDING = 'OUTSTANDING',
  OVERDUE_AMOUNT = 'OVERDUE_AMOUNT',
}

export enum InterestType {
  FLAT = 'FLAT',
  REDUCING = 'REDUCING',
}

/**
 * No PENDING_* status on LoanProduct itself — same pattern as Group/Staff:
 * a LoanProduct document doesn't exist until its CREATE workflow request is
 * approved. REJECTED is kept for symmetry/documentation of the state space
 * but, same caveat as Group/Staff, is never actually produced (a rejected
 * creation never persists a document at all).
 */
export enum ProductStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  REJECTED = 'REJECTED',
}
