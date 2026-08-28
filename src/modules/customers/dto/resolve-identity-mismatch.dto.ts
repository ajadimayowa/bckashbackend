import { IsBoolean, IsOptional, IsString, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';

/**
 * Resolves whatever BVN-submission mismatch flags are currently unresolved
 * on this customer (see CustomerService.buildMismatchFlags /
 * resolveIdentityMismatch). `fullName`/`phoneNumber` only need to be
 * supplied when `useSubmittedValues` is true and the corresponding field
 * was actually flagged — the service validates that precisely, this DTO
 * just handles the always-required `reason` in that case.
 */
export class ResolveIdentityMismatchDto {
  @IsBoolean()
  useSubmittedValues!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  fullName?: string;

  @IsOptional()
  @Matches(/^\d{7,15}$/, { message: 'phoneNumber must contain 7 to 15 digits' })
  phoneNumber?: string;

  @ValidateIf((dto: ResolveIdentityMismatchDto) => dto.useSubmittedValues === true)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason?: string;
}
