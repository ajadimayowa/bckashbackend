import { IsEmail, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/**
 * "additionalFields" from the brief is interpreted narrowly as `email` —
 * the only other optional Customer field not covered elsewhere in this flow.
 * See PHASE_5_NOTES.md.
 */
export class UpdateOnboardingDetailsDto {
  @IsOptional()
  @IsString()
  @MaxLength(240)
  address?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @Matches(/^\d{11}$/, { message: 'nin must be exactly 11 digits' })
  nin?: string;
}
