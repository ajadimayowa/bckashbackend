import {
  ArrayUnique,
  IsArray,
  IsEmail,
  IsEnum,
  IsMongoId,
  IsNotEmpty,
  IsString,
  IsStrongPassword,
  Matches,
  MaxLength,
} from 'class-validator';

import { ModuleName } from '../../../common/enums/identity.enums';

/**
 * Marketer onboarding only — role is implicitly MARKETER (see StaffService),
 * not accepted as a field, matching the brief: "Marketers are onboarded by
 * Branch Managers, subject to Admin/Approver approval."
 */
export class InitiateStaffOnboardingDto {
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

  @IsStrongPassword(
    { minLength: 10, minLowercase: 1, minUppercase: 1, minNumbers: 1, minSymbols: 1 },
    {
      message:
        'password must be at least 10 characters and include upper/lowercase, a number, and a symbol',
    },
  )
  password!: string;

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
