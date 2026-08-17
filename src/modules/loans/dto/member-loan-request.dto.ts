import { IsEnum, IsInt, IsMongoId, Min } from 'class-validator';

import { DisbursementChannel } from '../../../common/enums/loan.enums';

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
}
