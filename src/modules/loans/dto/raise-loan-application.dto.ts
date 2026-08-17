import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsInt, IsMongoId, Min, ValidateNested } from 'class-validator';

import { MemberLoanRequestDto } from './member-loan-request.dto';

export class RaiseLoanApplicationDto {
  @IsMongoId()
  groupId!: string;

  @IsMongoId()
  productId!: string;

  @IsInt()
  @Min(1)
  tenureMonths!: number;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => MemberLoanRequestDto)
  memberLoanRequests!: MemberLoanRequestDto[];
}
