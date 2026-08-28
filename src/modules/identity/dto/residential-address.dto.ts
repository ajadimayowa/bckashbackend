import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Nested on both InitiateStaffOnboardingDto and CreateStaffDirectDto — see
 * Staff schema's ResidentialAddress sub-document. Where the staff member
 * lives, distinct from `branchId` (where they work).
 */
export class ResidentialAddressDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  state!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  city!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(240)
  street!: string;
}
