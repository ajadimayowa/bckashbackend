import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { InterestType } from '../../../common/enums/loan-product.enums';
import { ApprovalChainStepDto } from './approval-chain-step.dto';
import { PenaltyRuleDto } from './penalty-rule.dto';

export class CreateLoanProductDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  /** Annual rate, basis points (1500 = 15.00%, never "15" flat). */
  @IsInt()
  @Min(0)
  @Max(100_000) // 1000.00% — a generous sanity ceiling, not a business rule
  interestRate!: number;

  @IsEnum(InterestType)
  interestType!: InterestType;

  /** Months, e.g. [3, 6, 12]. */
  @IsArray()
  @ArrayMinSize(1)
  @IsInt({ each: true })
  @Min(1, { each: true })
  tenureOptions!: number[];

  /** Hard floor of 3 — the system-wide group minimum. */
  @IsInt()
  @Min(3)
  minGroupSize!: number;

  @IsArray()
  @IsMongoId({ each: true })
  feeIds!: string[];

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ApprovalChainStepDto)
  approvalChainSteps!: ApprovalChainStepDto[];

  @ValidateNested()
  @Type(() => PenaltyRuleDto)
  penaltyRule!: PenaltyRuleDto;
}
