import { IsIn, IsInt, IsMongoId, Min } from 'class-validator';

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
}
