import { IsDateString, IsEnum, IsInt, IsMongoId, IsNotEmpty, IsString, Min } from 'class-validator';

import { RepaymentChannel } from '../../../common/enums/repayment.enums';

export class RecordRepaymentDto {
  @IsMongoId()
  memberLoanAccountId!: string;

  @IsMongoId()
  branchBankAccountId!: string;

  @IsEnum(RepaymentChannel)
  channel!: RepaymentChannel;

  @IsString()
  @IsNotEmpty()
  transactionReference!: string;

  @IsInt()
  @Min(1)
  amountKobo!: number;

  @IsDateString()
  paymentDate!: string;
}
