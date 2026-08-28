import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class OrganisationAccountDetailDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  bankName!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  accountNumber!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  accountName!: string;
}
