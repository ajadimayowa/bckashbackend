import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsInt, IsOptional, IsString, Min, MaxLength, ValidateNested } from 'class-validator';

import { MemberLoanRequestDto } from './member-loan-request.dto';

/**
 * PATCH /loans/:id — raiser only, and only while the loan is still
 * PENDING_APPROVAL (see LoansService.updatePendingApplication's own doc
 * comment). Every field optional; only what's present is changed.
 * `memberLoanRequests`, when present, must reference the loan's existing
 * members by `customerId` — this never adds or removes one.
 */
export class UpdatePendingLoanApplicationDto {
  @IsOptional()
  @IsInt()
  @Min(14)
  tenureDays?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  purpose?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => MemberLoanRequestDto)
  memberLoanRequests?: MemberLoanRequestDto[];
}
