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
 * Every role this endpoint may ever create — deliberately excludes
 * SUPERADMIN. SuperAdmin accounts are only ever created by seeding the
 * database directly, never through any onboarding flow, workflow-mediated
 * or otherwise (see PHASE_3_NOTES.md's STAFF_CREATE_DIRECT_CAPABILITY
 * comment, which draws the same line for the *other* staff-creation path).
 */
export const ONBOARDABLE_STAFF_ROLES: readonly StaffRole[] = [
  StaffRole.MARKETER,
  StaffRole.MANAGER,
  StaffRole.ADMIN,
  StaffRole.APPROVER,
];

/**
 * Workflow-mediated staff onboarding (Branch-Manager-initiated, subject to
 * Admin/SuperAdmin/Approver approval — see the brief's "Marketers are
 * onboarded by Branch Managers, subject to Admin/Approver approval", now
 * generalized to any `role` in ONBOARDABLE_STAFF_ROLES rather than being
 * hard-coded to MARKETER). Whichever `role` is proposed here is exactly what
 * gets created on approval — see StaffService.handleWorkflowApproved.
 *
 * No `password` field — whoever initiates onboarding no longer invents one
 * on the new hire's behalf. A system-generated temporary password is
 * created once the request is approved (see StaffService.handleWorkflowApproved,
 * generate-temporary-password.util.ts) and emailed to the new hire directly,
 * who must change it on first login (Staff.mustChangePassword).
 */
export class InitiateStaffOnboardingDto {
  @IsIn(ONBOARDABLE_STAFF_ROLES)
  role!: StaffRole;

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

  // Nigerian mobile format: 0xxxxxxxxxx or +234xxxxxxxxxx — simple pattern check,
  // not full libphonenumber validation (kept dependency-free for now).
  @Matches(/^(?:\+234|0)[789]\d{9}$/, {
    message: 'phoneNumber must be a valid Nigerian mobile number',
  })
  phoneNumber!: string;

  /**
   * Initiator/Authorizer RBAC (see StaffUserType's own doc comment,
   * identity.enums.ts) — real access control now, not display-only.
   * StaffService.resolveUserType overrides this to Initiator unconditionally
   * when `role` is MARKETER (non-negotiable, ignoring whatever's submitted
   * here), and rejects Reviewer as an invalid value for every other role.
   * `@IsEnum` alone stays permissive at the DTO layer since the valid set
   * depends on `role`, a sibling field — the real business rule lives in
   * that service method, not here.
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
  // comment; needed once POST /staff/onboard is called as multipart/
  // form-data (see StaffController, for the passportPhoto/idDocument files).
  @Transform(parseJsonField)
  @IsArray()
  @ArrayUnique()
  @IsEnum(ModuleName, { each: true })
  moduleAccess!: ModuleName[];

  /** Employment start date — see Staff.startDate. */
  @IsDateString()
  startDate!: string;

  /**
   * Optional, unlike the rest of this DTO — matches Staff.bvnEncrypted's own
   * "compulsory but not a blocker" design (see that field's doc comment on
   * the Staff schema). If supplied, it's encrypted and stored immediately
   * but *not* marked verified — an Admin still confirms it for real via the
   * separate POST /staff/:id/verify-bvn (StaffService.verifyBvn), which
   * actually calls the BVN provider. Never routed through that live
   * verification call at onboarding time itself.
   */
  @IsOptional()
  @Matches(/^\d{11}$/, { message: 'bvn must be exactly 11 digits' })
  bvn?: string;

  // Same JSON-encoded-string tolerance as moduleAccess above — a form-data
  // submission has no native nested-object encoding, so the client sends
  // e.g. `formData.append('residentialAddress', JSON.stringify({...}))`.
  // `parseJsonFieldAsInstance` (not the plain `parseJsonField`) — see its
  // own doc comment: a bare @Transform on a @ValidateNested() field skips
  // @Type()'s instantiation, which whitelist-rejects every property on the
  // resulting plain object.
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
