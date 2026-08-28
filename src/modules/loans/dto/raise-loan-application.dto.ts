import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { MemberLoanRequestDto } from './member-loan-request.dto';

export class RaiseLoanApplicationDto {
  @IsMongoId()
  groupId!: string;

  @IsMongoId()
  productId!: string;

  /** Free-text reason for the loan — optional, purely informational, never gated on. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  purpose?: string;

  /** Must be one of the selected product's own tenureOptions — checked in LoansService.raiseApplication. @Min here is just the system-wide floor (see LoanProduct.tenureOptions's own doc comment), not per-product validation. */
  @IsInt()
  @Min(14)
  tenureDays!: number;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => MemberLoanRequestDto)
  memberLoanRequests!: MemberLoanRequestDto[];

  /** From POST /loans/consent/request — see LoanConsentService. Must have been issued for one of memberLoanRequests' customerIds. */
  @IsMongoId()
  consentChallengeId!: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'consentCode must be a 6-digit code' })
  consentCode!: string;
}
