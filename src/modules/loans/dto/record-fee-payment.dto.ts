import { IsIn, IsInt, IsMongoId, IsOptional, IsString, Min } from 'class-validator';

import { FeePaymentStatus } from '../../../common/enums/loan.enums';

export class RecordFeePaymentDto {
  @IsMongoId()
  customerId!: string;

  @IsMongoId()
  productId!: string;

  @IsMongoId()
  feeDefinitionId!: string;

  @IsInt()
  @Min(0)
  amountKobo!: number;

  @IsIn([FeePaymentStatus.PAID, FeePaymentStatus.WAIVED])
  status!: FeePaymentStatus.PAID | FeePaymentStatus.WAIVED;

  /** Which bank account the fee was paid into — free text, only meaningful when status is PAID. */
  @IsOptional()
  @IsString()
  accountPaidTo?: string;

  /** Teller/transfer reference — free text, only meaningful when status is PAID. */
  @IsOptional()
  @IsString()
  paymentReference?: string;
}
