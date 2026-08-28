import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import {
  StaffEmploymentType,
  StaffRole,
  StaffUserType,
} from '../../../common/enums/identity.enums';
import { parseJsonFieldAsInstance } from '../../../common/upload/parse-json-field.util';
import { ContactPersonDto } from './contact-person.dto';
import { KycDetailsDto } from './kyc-details.dto';
import { ResidentialAddressDto } from './residential-address.dto';

/**
 * PATCH /staff/:id — an org:manage admin (ADMIN/SUPERADMIN) correcting or
 * filling in another staff member's record after the fact. Every field
 * optional: send only what's changing. Deliberately excludes:
 *  - `status` (use POST /staff/:id/disable|enable — reason-tracked, revokes tokens)
 *  - `bvn`/`bvnVerified` (use POST /staff/:id/verify-bvn — a live provider check, not a manual edit)
 *  - nin/guarantorForm/offerLetter verification (use PATCH /staff/:id/compliance)
 *  - passportPhoto/idDocument (use PATCH /staff/:id/documents — multipart)
 * See StaffService.updateProfile for the extra guardrails around `role`
 * (SUPERADMIN can neither be assigned nor edited away from through this route).
 */
export class UpdateStaffProfileDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  firstName?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  lastName?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @Matches(/^(?:\+234|0)[789]\d{9}$/, {
    message: 'phoneNumber must be a valid Nigerian mobile number',
  })
  phoneNumber?: string;

  /** Never SUPERADMIN via this route either as the new value or the existing one — see StaffService.updateProfile. */
  @IsOptional()
  @IsEnum(StaffRole)
  role?: StaffRole;

  @IsOptional()
  @IsEnum(StaffUserType)
  userType?: StaffUserType;

  @IsOptional()
  @IsMongoId()
  departmentId?: string;

  @IsOptional()
  @IsMongoId()
  unitId?: string;

  @IsOptional()
  @IsMongoId()
  branchId?: string;

  @IsOptional()
  @IsEnum(StaffEmploymentType)
  employmentType?: StaffEmploymentType;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  salaryGrade?: string;

  /** Another Staff's id — who this person reports to. Pass an empty string to clear it. */
  @IsOptional()
  @IsString()
  managerId?: string;

  // parseJsonFieldAsInstance, not the plain parseJsonField — see that
  // util's own doc comment for why a bare @Transform on a @ValidateNested()
  // field silently skips @Type()'s instantiation and whitelist-rejects
  // every property on the resulting plain object. Passes undefined/null
  // through untouched, so @IsOptional() above still works as expected.
  @IsOptional()
  @Transform(parseJsonFieldAsInstance(ResidentialAddressDto))
  @ValidateNested()
  residentialAddress?: ResidentialAddressDto;

  @IsOptional()
  @Transform(parseJsonFieldAsInstance(KycDetailsDto))
  @ValidateNested()
  kyc?: KycDetailsDto;

  @IsOptional()
  @Transform(parseJsonFieldAsInstance(ContactPersonDto))
  @ValidateNested()
  nextOfKin?: ContactPersonDto;

  @IsOptional()
  @Transform(parseJsonFieldAsInstance(ContactPersonDto))
  @ValidateNested()
  reference?: ContactPersonDto;
}
