import {
  IsArray,
  IsBoolean,
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
} from '../../../common/enums/loan-product.enums';

/** Every field optional — only the fields present are changed. See FeeDefinitionsService.initiateUpdate. */
export class UpdateFeeDefinitionDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsEnum(FeeCategory)
  category?: FeeCategory;

  @IsOptional()
  @IsEnum(FeeTiming)
  timing?: FeeTiming;

  @IsOptional()
  @IsEnum(FeeCalcType)
  calcType?: FeeCalcType;

  @IsOptional()
  @IsInt()
  @Min(0)
  value?: number;

  @IsOptional()
  @IsEnum(FeePercentageBasis)
  percentageOf?: FeePercentageBasis;

  @IsOptional()
  @IsEnum(FeeAppliesTo)
  appliesTo?: FeeAppliesTo;

  @IsOptional()
  @IsArray()
  @IsMongoId({ each: true })
  productIds?: string[];

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
