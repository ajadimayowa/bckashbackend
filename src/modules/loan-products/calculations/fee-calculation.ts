import { FeeCalcType, FeePercentageBasis } from '../../../common/enums/loan-product.enums';
import { assertNonNegativeInteger, roundHalfUp } from './rounding.util';

/** The subset of FeeDefinition this function actually needs — callers pass a full FeeDefinition document fine, this just doesn't require one. */
export interface FeeLike {
  calcType: FeeCalcType;
  /** Kobo if FIXED; basis points if PERCENTAGE. */
  value: number;
  percentageOf?: FeePercentageBasis | null;
}

/** Only the bases a caller happens to have available need be supplied. */
export interface FeeCalculationContext {
  principal?: number;
  outstanding?: number;
  overdueAmount?: number;
}

const CONTEXT_FIELD_FOR_BASIS: Record<FeePercentageBasis, keyof FeeCalculationContext> = {
  [FeePercentageBasis.PRINCIPAL]: 'principal',
  [FeePercentageBasis.OUTSTANDING]: 'outstanding',
  [FeePercentageBasis.OVERDUE_AMOUNT]: 'overdueAmount',
};

function contextValueFor(basis: FeePercentageBasis, context: FeeCalculationContext): number {
  const field = CONTEXT_FIELD_FOR_BASIS[basis];
  const value = context[field];

  if (value === undefined) {
    throw new Error(
      `A PERCENTAGE fee with percentageOf=${basis} requires context.${field} to be supplied`,
    );
  }
  assertNonNegativeInteger(value, `context.${field}`);
  return value;
}

/**
 * Returns the fee amount in kobo. FIXED returns `fee.value` directly.
 * PERCENTAGE computes `round(base * value / 10_000)` — basis points to a
 * fraction — against whichever context field `fee.percentageOf` names,
 * throwing if that field wasn't supplied rather than silently computing
 * against `undefined`. See PHASE_7_NOTES.md for the rounding rule.
 */
export function calculateFeeAmount(fee: FeeLike, context: FeeCalculationContext): number {
  assertNonNegativeInteger(fee.value, 'fee.value');

  if (fee.calcType === FeeCalcType.FIXED) {
    return fee.value;
  }

  if (!fee.percentageOf) {
    throw new Error('fee.percentageOf is required when fee.calcType is PERCENTAGE');
  }
  const base = contextValueFor(fee.percentageOf, context);
  return roundHalfUp((base * fee.value) / 10_000);
}

/**
 * Thin, semantically-named wrapper over calculateFeeAmount for the
 * EARLY_LIQUIDATION fee category — always computed against the
 * outstanding balance at the moment of liquidation, whether the fee
 * definition itself is FIXED or PERCENTAGE-of-OUTSTANDING.
 */
export function calculateEarlyLiquidationFee(
  earlyLiquidationFeeDef: FeeLike,
  outstandingBalanceKobo: number,
): number {
  assertNonNegativeInteger(outstandingBalanceKobo, 'outstandingBalanceKobo');
  return calculateFeeAmount(earlyLiquidationFeeDef, { outstanding: outstandingBalanceKobo });
}
