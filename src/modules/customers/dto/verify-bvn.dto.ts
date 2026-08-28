import { IsMongoId, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/**
 * The whole of "step 1" in one call — the real BC Kash MFB provider has no
 * OTP/consent step (see BvnVerificationAdapter's own doc comment), so this
 * replaces the old two-request StartBvnConsentDto/ConfirmBvnConsentDto pair.
 */
export class VerifyBvnDto {
  @Matches(/^\d{11}$/, { message: 'bvn must be exactly 11 digits' })
  bvn!: string;

  @IsMongoId()
  branchId!: string;

  /**
   * What the marketer typed at intake — diffed against the provider's
   * resolved name/phone to populate KycRecord.mismatchFlags. Optional so a
   * caller that doesn't have this yet can still verify.
   */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  fullName?: string;

  @IsOptional()
  @Matches(/^\d{7,15}$/, { message: 'phoneNumber must contain 7 to 15 digits' })
  phoneNumber?: string;
}
