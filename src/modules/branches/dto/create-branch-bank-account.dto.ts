import { IsBoolean, IsEnum, IsMongoId, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

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

  /**
   * Defaults to `true` only when this is the branch's first account,
   * `false` otherwise — a branch may have many accounts but at most one is
   * ever `active` at a time (see BranchBankAccountsService.create). Passing
   * `true` explicitly deactivates whichever other account currently holds
   * that spot.
   */
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
