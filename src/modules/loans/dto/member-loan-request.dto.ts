import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsMongoId, Min, ValidateIf, ValidateNested } from 'class-validator';

import { DisbursementChannel } from '../../../common/enums/loan.enums';
import { BankAccountDetailsDto } from './bank-account-details.dto';

/**
 * `disbursementChannel` per member — NOT in the brief's literal
 * `memberLoanRequests: { customerId, requestedAmountKobo }[]` signature, but
 * `MemberLoanAccount.disbursementChannel` is a required schema field with no
 * default, and nothing later in the flow supplies it — a member's preferred
 * disbursement channel is most naturally chosen at application time. See
 * PHASE_8_NOTES.md.
 */
export class MemberLoanRequestDto {
  @IsMongoId()
  customerId!: string;

  @IsInt()
  @Min(1)
  requestedAmountKobo!: number;

  @IsEnum(DisbursementChannel)
  disbursementChannel!: DisbursementChannel;

  /** Required iff disbursementChannel is TRANSFER — re-checked in LoansService.raiseApplication, not just here. */
  @ValidateIf((dto: MemberLoanRequestDto) => dto.disbursementChannel === DisbursementChannel.TRANSFER)
  @ValidateNested()
  @Type(() => BankAccountDetailsDto)
  bankAccountDetails?: BankAccountDetailsDto;
}
