import { Transform } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsDateString,
  IsEmail,
  IsEnum,
  IsIn,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { ModuleName, StaffRole, StaffUserType } from '../../../common/enums/identity.enums';
import {
  parseJsonField,
  parseJsonFieldAsInstance,
} from '../../../common/upload/parse-json-field.util';
import { ContactPersonDto } from './contact-person.dto';
import { KycDetailsDto } from './kyc-details.dto';
import { ResidentialAddressDto } from './residential-address.dto';

/**
 * SuperAdmin direct-creation path — MARKETER must go through
 * InitiateStaffOnboardingDto's workflow instead, and SUPERADMIN accounts are
 * out of scope for this endpoint entirely (see PHASE_3_NOTES.md: how the
 * first SuperAdmin gets created is an open question, not answered by this DTO).
 *
 * No `password` field — see InitiateStaffOnboardingDto's identical comment;
 * same system-generated-temporary-password design, just synchronous instead
 * of workflow-mediated (see StaffService.createDirect).
 */
export class CreateStaffDirectDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  firstName!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  lastName!: string;

  @IsEmail()
  email!: string;

  @Matches(/^(?:\+234|0)[789]\d{9}$/, {
    message: 'phoneNumber must be a valid Nigerian mobile number',
  })
  phoneNumber!: string;

  @IsIn([StaffRole.MANAGER, StaffRole.ADMIN, StaffRole.APPROVER])
  role!: StaffRole.MANAGER | StaffRole.ADMIN | StaffRole.APPROVER;

  /**
   * Initiator/Authorizer RBAC (see StaffUserType's own doc comment,
   * identity.enums.ts) — real access control now, not display-only.
   * StaffService.resolveUserType rejects Reviewer as an invalid value here
   * (MARKETER is out of scope for this endpoint entirely, so the
   * force-to-Initiator branch never applies).
   */
  @IsEnum(StaffUserType)
  userType!: StaffUserType;

  @IsMongoId()
  departmentId!: string;

  @IsMongoId()
  unitId!: string;

  @IsMongoId()
  branchId!: string;

  // Also accepts a JSON-encoded string — see parseJsonField's own doc
  // comment; needed once POST /staff/direct is called as multipart/
  // form-data (see StaffController, for the passportPhoto/idDocument files).
  @Transform(parseJsonField)
  @IsArray()
  @ArrayUnique()
  @IsEnum(ModuleName, { each: true })
  moduleAccess!: ModuleName[];

  /** Employment start date — see Staff.startDate. */
  @IsDateString()
  startDate!: string;

  /** Optional — see InitiateStaffOnboardingDto's identical `bvn` field for why. */
  @IsOptional()
  @Matches(/^\d{11}$/, { message: 'bvn must be exactly 11 digits' })
  bvn?: string;

  // parseJsonFieldAsInstance, not the plain parseJsonField — see that
  // util's own doc comment for why a bare @Transform on a @ValidateNested()
  // field silently skips @Type()'s instantiation and whitelist-rejects
  // every property on the resulting plain object.
  @Transform(parseJsonFieldAsInstance(ResidentialAddressDto))
  @ValidateNested()
  residentialAddress!: ResidentialAddressDto;

  @Transform(parseJsonFieldAsInstance(KycDetailsDto))
  @ValidateNested()
  kyc!: KycDetailsDto;

  @Transform(parseJsonFieldAsInstance(ContactPersonDto))
  @ValidateNested()
  nextOfKin!: ContactPersonDto;

  @Transform(parseJsonFieldAsInstance(ContactPersonDto))
  @ValidateNested()
  reference!: ContactPersonDto;
}
