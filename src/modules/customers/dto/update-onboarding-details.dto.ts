import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class NextOfKinDto {
  @IsString()
  @MaxLength(120)
  fullName!: string;

  @Matches(/^\d{7,15}$/, { message: 'phoneNumber must contain 7 to 15 digits' })
  phoneNumber!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  relationship?: string;
}

export class GuarantorDto {
  @IsString()
  @MaxLength(120)
  fullName!: string;

  @Matches(/^\d{7,15}$/, { message: 'phoneNumber must contain 7 to 15 digits' })
  phoneNumber!: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  relationship?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  occupation?: string;
}

export class ReferenceDto {
  @IsString()
  @MaxLength(120)
  fullName!: string;

  @Matches(/^\d{7,15}$/, { message: 'phoneNumber must contain 7 to 15 digits' })
  phoneNumber!: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  relationship?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  occupation?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  yearsKnown?: string;
}

/**
 * "additionalFields" from the brief is interpreted narrowly as `email` —
 * the only other optional Customer field not covered elsewhere in this flow.
 * See PHASE_5_NOTES.md.
 *
 * `nextOfKin`/`guarantors`/`reference` added later — free-text, non-KYC
 * contact information (no encryption, no verification concept), same
 * creator-only/PENDING_APPROVAL-only rules as everything else on this DTO.
 * `guarantors` replaces the whole array on every call (not a partial merge)
 * — same "send the full current set" contract the frontend's guarantor 1/2/3
 * form already used.
 */
export class UpdateOnboardingDetailsDto {
  @IsOptional()
  @IsString()
  @MaxLength(240)
  address?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @Matches(/^\d{11}$/, { message: 'nin must be exactly 11 digits' })
  nin?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => NextOfKinDto)
  nextOfKin?: NextOfKinDto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => GuarantorDto)
  guarantors?: GuarantorDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => ReferenceDto)
  reference?: ReferenceDto;
}
