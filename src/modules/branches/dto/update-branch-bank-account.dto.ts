import { IsBoolean, IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

import { BranchBankAccountPurpose } from '../../../common/enums/branch.enums';

export class UpdateBranchBankAccountDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  bankName?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  accountNumber?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  accountName?: string;

  @IsOptional()
  @IsEnum(BranchBankAccountPurpose)
  purpose?: BranchBankAccountPurpose;

  /** The sanctioned way to retire an account — never a hard delete. See PHASE_4_NOTES.md. */
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
