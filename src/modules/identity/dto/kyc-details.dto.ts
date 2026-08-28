import { IsDateString, IsEnum, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { Gender, IdentificationType } from '../../../common/enums/identity.enums';

/**
 * Nested on both InitiateStaffOnboardingDto and CreateStaffDirectDto — see
 * Staff schema's Kyc sub-document. Deliberately doesn't include `bvn` — see
 * that field's own doc comment on the two onboarding DTOs.
 */
export class KycDetailsDto {
  @IsDateString()
  dateOfBirth!: string;

  @IsEnum(Gender)
  gender!: Gender;

  @IsEnum(IdentificationType)
  idType!: IdentificationType;

  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  idNumber!: string;
}
