import { IsEnum, IsInt, IsOptional, Min } from 'class-validator';

import {
  FeeCalcType,
  PenaltyFrequency,
  PenaltyPercentageBasis,
} from '../../../common/enums/loan-product.enums';

export class PenaltyRuleDto {
  @IsEnum(FeeCalcType)
  calcType!: FeeCalcType;

  /** Kobo if calcType is FIXED; basis points if PERCENTAGE. */
  @IsInt()
  @Min(0)
  value!: number;

  /** Required when calcType is PERCENTAGE — validated by LoanProductsService. */
  @IsOptional()
  @IsEnum(PenaltyPercentageBasis)
  percentageOf?: PenaltyPercentageBasis;

  @IsInt()
  @Min(0)
  gracePeriodDays!: number;

  /** Added in Phase 9 — see loan-product.schema.ts's PenaltyRule. */
  @IsEnum(PenaltyFrequency)
  frequency!: PenaltyFrequency;

  /** Required when frequency is RECURRING — validated by LoanProductsService. */
  @IsOptional()
  @IsInt()
  @Min(1)
  recurrenceIntervalDays?: number;

  /** Optional even when RECURRING — omitted means no cap. */
  @IsOptional()
  @IsInt()
  @Min(1)
  maxRecurrences?: number;
}
