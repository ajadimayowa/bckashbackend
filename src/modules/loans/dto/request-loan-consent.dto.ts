import { IsMongoId } from 'class-validator';

export class RequestLoanConsentDto {
  @IsMongoId()
  customerId!: string;
}
