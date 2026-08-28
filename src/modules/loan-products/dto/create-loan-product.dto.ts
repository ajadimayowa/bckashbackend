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

  /** Days, e.g. [14, 30, 60] — 14 is the system-wide floor. */
  @IsArray()
  @ArrayMinSize(1)
  @IsInt({ each: true })
  @Min(14, { each: true })
  tenureOptions!: number[];

  /** Hard floor of 3 — the system-wide group minimum. */
  @IsInt()
  @Min(3)
  minGroupSize!: number;

  /** Days per repayment installment — defaults to 7 (weekly) when omitted. See LoanProduct.repaymentPeriodDays's own doc comment. */
  @IsOptional()
  @IsInt()
  @Min(1)
  repaymentPeriodDays?: number;

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
