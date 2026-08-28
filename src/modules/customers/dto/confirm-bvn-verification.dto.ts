import { IsBoolean, IsMongoId, IsOptional, IsString, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';

/**
 * "Step 2" — the moment a Customer/KycRecord actually gets created from a
 * still-live BvnVerificationPreview (see CustomerService.previewBvn's own
 * doc comment for why creation is deferred this far). Same
 * useSubmittedValues/fullName/phoneNumber/reason shape as
 * ResolveIdentityMismatchDto — this is the same choice, just made before
 * creation rather than as a later patch.
 */
export class ConfirmBvnVerificationDto {
  @IsMongoId()
  previewId!: string;

  @IsBoolean()
  useSubmittedValues!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  fullName?: string;

  @IsOptional()
  @Matches(/^\d{7,15}$/, { message: 'phoneNumber must contain 7 to 15 digits' })
  phoneNumber?: string;

  @ValidateIf((dto: ConfirmBvnVerificationDto) => dto.useSubmittedValues === true)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason?: string;
}
