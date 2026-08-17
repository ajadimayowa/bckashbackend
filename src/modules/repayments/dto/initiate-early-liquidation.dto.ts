import { IsMongoId } from 'class-validator';

export class InitiateEarlyLiquidationDto {
  @IsMongoId()
  memberLoanAccountId!: string;
}
