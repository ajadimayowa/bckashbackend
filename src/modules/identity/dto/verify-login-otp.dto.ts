import { IsMongoId, IsNotEmpty, IsString, Length } from 'class-validator';

export class VerifyLoginOtpDto {
  @IsMongoId()
  challengeId!: string;

  @IsString()
  @IsNotEmpty()
  @Length(6, 6, { message: 'code must be a 6-digit OTP' })
  code!: string;
}
