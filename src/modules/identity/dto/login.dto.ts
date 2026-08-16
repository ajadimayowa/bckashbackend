import { IsEmail, IsNotEmpty, IsString } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email!: string;

  // Intentionally no complexity check here — that's enforced at account
  // creation time; login just needs *a* string to compare against the hash.
  @IsString()
  @IsNotEmpty()
  password!: string;
}
