import { IsEnum, IsMongoId, IsNotEmpty, IsString, MaxLength } from 'class-validator';

import { BranchBankAccountPurpose } from '../../../common/enums/branch.enums';

export class CreateBranchBankAccountDto {
  @IsMongoId()
  branchId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  bankName!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  accountNumber!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  accountName!: string;

  @IsEnum(BranchBankAccountPurpose)
  purpose!: BranchBankAccountPurpose;
}
