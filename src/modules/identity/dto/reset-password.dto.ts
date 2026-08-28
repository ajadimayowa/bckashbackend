import { IsEmail, IsNotEmpty, IsString, IsStrongPassword, Length } from 'class-validator';

export class ResetPasswordDto {
  /** Same email `POST /auth/forgot-password` was called with. */
  @IsEmail()
  email!: string;

  /** The 6-digit code emailed by `POST /auth/forgot-password`. */
  @IsString()
  @IsNotEmpty()
  @Length(6, 6, { message: 'code must be a 6-digit code' })
  code!: string;

  @IsStrongPassword(
    { minLength: 10, minLowercase: 1, minUppercase: 1, minNumbers: 1, minSymbols: 1 },
    {
      message:
        'newPassword must be at least 10 characters and include upper/lowercase, a number, and a symbol',
    },
  )
  newPassword!: string;
}
