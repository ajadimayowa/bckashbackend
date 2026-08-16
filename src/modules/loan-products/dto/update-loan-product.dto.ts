import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { InterestType, ProductStatus } from '../../../common/enums/loan-product.enums';
import { ApprovalChainStepDto } from './approval-chain-step.dto';
import { PenaltyRuleDto } from './penalty-rule.dto';

/** Every field optional — only the fields present are changed. See LoanProductsService.initiateUpdate. */
export class UpdateLoanProductDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000)
  interestRate?: number;

  @IsOptional()
  @IsEnum(InterestType)
  interestType?: InterestType;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsInt({ each: true })
  @Min(1, { each: true })
  tenureOptions?: number[];

  @IsOptional()
  @IsInt()
  @Min(3)
  minGroupSize?: number;

  @IsOptional()
  @IsArray()
  @IsMongoId({ each: true })
  feeIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ApprovalChainStepDto)
  approvalChainSteps?: ApprovalChainStepDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => PenaltyRuleDto)
  penaltyRule?: PenaltyRuleDto;

  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;
}
