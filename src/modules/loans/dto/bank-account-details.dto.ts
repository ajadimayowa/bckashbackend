import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** Required on a MemberLoanRequestDto entry iff disbursementChannel is TRANSFER — see that DTO's own comment. */
export class BankAccountDetailsDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  accountName!: string;

  /** Nigerian NUBAN — 10 digits. Not validated against a live bank-lookup provider (none is wired up yet, see BankTransferPort's own doc comment). */
  @IsString()
  @IsNotEmpty()
  @MaxLength(10)
  accountNumber!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  bankName!: string;
}
