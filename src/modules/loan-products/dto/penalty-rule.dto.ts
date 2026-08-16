import { IsEnum, IsInt, IsOptional, Min } from 'class-validator';

import { FeeCalcType, PenaltyPercentageBasis } from '../../../common/enums/loan-product.enums';

export class PenaltyRuleDto {
  @IsEnum(FeeCalcType)
  calcType!: FeeCalcType;

  /** Kobo if calcType is FIXED; basis points if PERCENTAGE. */
  @IsInt()
  @Min(0)
  value!: number;

  /** Required when calcType is PERCENTAGE — validated by LoanProductsService. Never PRINCIPAL. */
  @IsOptional()
  @IsEnum(PenaltyPercentageBasis)
  percentageOf?: PenaltyPercentageBasis;

  @IsInt()
  @Min(0)
  gracePeriodDays!: number;
}
