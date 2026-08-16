import { FeeCalcType, PenaltyPercentageBasis } from '../../../common/enums/loan-product.enums';
import { assertNonNegativeInteger, roundHalfUp } from './rounding.util';

export interface PenaltyRuleLike {
  calcType: FeeCalcType;
  /** Kobo if FIXED; basis points if PERCENTAGE. */
  value: number;
  percentageOf?: PenaltyPercentageBasis | null;
  gracePeriodDays: number;
}

/**
 * Returns 0 while `daysLate <= gracePeriodDays` (grace period is inclusive
 * of its boundary day — exactly `gracePeriodDays` late is still within
 * grace, `gracePeriodDays + 1` is the first late day a penalty applies).
 * Beyond grace, FIXED returns `penaltyRule.value` directly; PERCENTAGE
 * computes `round(overdueAmountKobo * value / 10_000)`.
 *
 * `overdueAmountKobo` is a single amount — this function does not fork
 * behavior on `penaltyRule.percentageOf` (OUTSTANDING vs OVERDUE_AMOUNT);
 * it trusts the caller (Phase 9) to have already passed whichever amount
 * matches the rule's configured basis. `percentageOf` is still validated as
 * present/required for a PERCENTAGE rule, since an unset basis on the rule
 * itself is a genuine configuration error worth throwing on — see
 * PHASE_7_NOTES.md for why the signature doesn't split this into two
 * separate amount parameters the way calculateFeeAmount's context object
 * does.
 */
export function calculatePenaltyAmount(
  penaltyRule: PenaltyRuleLike,
  overdueAmountKobo: number,
  daysLate: number,
): number {
  assertNonNegativeInteger(overdueAmountKobo, 'overdueAmountKobo');
  assertNonNegativeInteger(daysLate, 'daysLate');
  assertNonNegativeInteger(penaltyRule.gracePeriodDays, 'penaltyRule.gracePeriodDays');

  if (daysLate <= penaltyRule.gracePeriodDays) {
    return 0;
  }

  assertNonNegativeInteger(penaltyRule.value, 'penaltyRule.value');

  if (penaltyRule.calcType === FeeCalcType.FIXED) {
    return penaltyRule.value;
  }

  if (!penaltyRule.percentageOf) {
    throw new Error('penaltyRule.percentageOf is required when penaltyRule.calcType is PERCENTAGE');
  }
  return roundHalfUp((overdueAmountKobo * penaltyRule.value) / 10_000);
}
