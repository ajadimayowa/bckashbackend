import {
  IsArray,
  IsEnum,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

import {
  FeeAppliesTo,
  FeeCalcType,
  FeeCategory,
  FeePercentageBasis,
  FeeTiming,
  PenaltyFrequency,
} from '../../../common/enums/loan-product.enums';

export class CreateFeeDefinitionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @IsEnum(FeeCategory)
  category!: FeeCategory;

  @IsEnum(FeeTiming)
  timing!: FeeTiming;

  @IsEnum(FeeCalcType)
  calcType!: FeeCalcType;

  /** Kobo if calcType is FIXED; basis points if PERCENTAGE. Must be a non-negative integer either way. */
  @IsInt()
  @Min(0)
  value!: number;

  /**
   * Required when calcType is PERCENTAGE — validated by FeeDefinitionsService
   * (a plain @IsEnum here can't see the sibling `calcType` field). Ignored
   * (normalized to null) when calcType is FIXED, even if supplied.
   */
  @IsOptional()
  @IsEnum(FeePercentageBasis)
  percentageOf?: FeePercentageBasis;

  @IsEnum(FeeAppliesTo)
  appliesTo!: FeeAppliesTo;

  @IsOptional()
  @IsArray()
  @IsMongoId({ each: true })
  productIds?: string[];

  /** Added in Phase 9 — see fee-definition.schema.ts. Defaults to ONE_TIME if omitted. */
  @IsOptional()
  @IsEnum(PenaltyFrequency)
  frequency?: PenaltyFrequency;

  /** Required when frequency is RECURRING — validated by FeeDefinitionsService. */
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
