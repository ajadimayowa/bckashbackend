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
 * SIGNATURE CHANGED IN PHASE 9 (see PHASE_9_NOTES.md) — this function used to
 * take a single `overdueAmountKobo: number` and explicitly declined to fork on
 * `percentageOf`, trusting the caller to pass whichever amount matched the
 * rule's basis. Phase 9's recurring penalty/delay-charge sweep needs to
 * compute a charge against three *different* bases across periods —
 * PRINCIPAL (flat, never changes — this is what makes a PRINCIPAL-basis
 * recurring charge non-compounding), OUTSTANDING (grows as unpaid penalties
 * are folded back into the balance — this is what makes it compound), and
 * OVERDUE_AMOUNT — so the function now takes a context object, exactly
 * mirroring `calculateFeeAmount`'s existing pattern, and does the basis
 * selection itself rather than leaving it to the caller.
 */
export interface PenaltyCalculationContext {
  overdueAmountKobo?: number;
  outstandingBalanceKobo?: number;
  principalKobo?: number;
}

const CONTEXT_FIELD_FOR_BASIS: Record<PenaltyPercentageBasis, keyof PenaltyCalculationContext> = {
  [PenaltyPercentageBasis.PRINCIPAL]: 'principalKobo',
  [PenaltyPercentageBasis.OUTSTANDING]: 'outstandingBalanceKobo',
  [PenaltyPercentageBasis.OVERDUE_AMOUNT]: 'overdueAmountKobo',
};

function contextValueFor(
  basis: PenaltyPercentageBasis,
  context: PenaltyCalculationContext,
): number {
  const field = CONTEXT_FIELD_FOR_BASIS[basis];
  const value = context[field];
  if (value === undefined) {
    throw new Error(
      `A PERCENTAGE penaltyRule with percentageOf=${basis} requires context.${field} to be supplied`,
    );
  }
  assertNonNegativeInteger(value, `context.${field}`);
  return value;
}

/**
 * Returns 0 while `daysLate <= gracePeriodDays` (grace period is inclusive
 * of its boundary day — exactly `gracePeriodDays` late is still within
 * grace, `gracePeriodDays + 1` is the first late day a penalty applies).
 * Beyond grace, FIXED returns `penaltyRule.value` directly; PERCENTAGE
 * computes `round(base * value / 10_000)` against whichever context field
 * `penaltyRule.percentageOf` names, throwing if that field wasn't supplied.
 *
 * Frequency-agnostic by design — this function has no notion of "period" or
 * "recurring"; it answers "what is today's charge, given these facts" for a
 * single point in time. `PenaltySweepService` (Phase 9,
 * `modules/repayments`) is what decides *how many times* to call this and
 * with what context per period, and owns the idempotency/period-index
 * mechanism that makes repeated calls safe.
 */
export function calculatePenaltyAmount(
  penaltyRule: PenaltyRuleLike,
  context: PenaltyCalculationContext,
  daysLate: number,
): number {
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
  const base = contextValueFor(penaltyRule.percentageOf, context);
  return roundHalfUp((base * penaltyRule.value) / 10_000);
}
