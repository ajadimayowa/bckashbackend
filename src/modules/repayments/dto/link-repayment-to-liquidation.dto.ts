import { IsMongoId } from 'class-validator';

export class LinkRepaymentToLiquidationDto {
  @IsMongoId()
  liquidationRequestId!: string;
}
