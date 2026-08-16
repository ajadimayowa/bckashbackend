import {
  ArrayUnique,
  IsArray,
  IsEmail,
  IsEnum,
  IsIn,
  IsMongoId,
  IsNotEmpty,
  IsString,
  IsStrongPassword,
  Matches,
  MaxLength,
} from 'class-validator';

import { ModuleName, StaffRole } from '../../../common/enums/identity.enums';

/**
 * SuperAdmin direct-creation path — MARKETER must go through
 * InitiateStaffOnboardingDto's workflow instead, and SUPERADMIN accounts are
 * out of scope for this endpoint entirely (see PHASE_3_NOTES.md: how the
 * first SuperAdmin gets created is an open question, not answered by this DTO).
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

  @IsStrongPassword(
    { minLength: 10, minLowercase: 1, minUppercase: 1, minNumbers: 1, minSymbols: 1 },
    {
      message:
        'password must be at least 10 characters and include upper/lowercase, a number, and a symbol',
    },
  )
  password!: string;

  @IsIn([StaffRole.MANAGER, StaffRole.ADMIN, StaffRole.APPROVER])
  role!: StaffRole.MANAGER | StaffRole.ADMIN | StaffRole.APPROVER;

  @IsMongoId()
  departmentId!: string;

  @IsMongoId()
  unitId!: string;

  @IsMongoId()
  branchId!: string;

  @IsArray()
  @ArrayUnique()
  @IsEnum(ModuleName, { each: true })
  moduleAccess!: ModuleName[];
}
