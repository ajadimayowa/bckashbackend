import { IsEmail } from 'class-validator';

export class ForgotPasswordDto {
  /** The email a reset code is sent to, if it belongs to an ACTIVE staff account. */
  @IsEmail()
  email!: string;
}
