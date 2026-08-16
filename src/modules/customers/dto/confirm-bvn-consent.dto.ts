import { IsMongoId, IsString, Length } from 'class-validator';

export class ConfirmBvnConsentDto {
  @IsMongoId()
  pendingConsentId!: string;

  // 4-8 chars — matches the confirmed provider contract's own OTP validation range.
  @IsString()
  @Length(4, 8)
  otp!: string;
}
