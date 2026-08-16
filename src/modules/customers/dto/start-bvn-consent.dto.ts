import { IsMongoId, Matches } from 'class-validator';

export class StartBvnConsentDto {
  @Matches(/^\d{11}$/, { message: 'bvn must be exactly 11 digits' })
  bvn!: string;

  @IsMongoId()
  branchId!: string;
}
