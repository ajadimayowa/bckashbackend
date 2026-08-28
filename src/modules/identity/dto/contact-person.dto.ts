import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

/**
 * Shared shape for both `nextOfKin` and `reference` on
 * InitiateStaffOnboardingDto/CreateStaffDirectDto — see Staff schema's
 * ContactPerson sub-document, which this maps onto 1:1.
 */
export class ContactPersonDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  name!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  relationship!: string;

  @Matches(/^(?:\+234|0)[789]\d{9}$/, {
    message: 'phoneNumber must be a valid Nigerian mobile number',
  })
  phoneNumber!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(240)
  address!: string;
}
