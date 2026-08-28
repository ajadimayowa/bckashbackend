import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { OrganisationAccountDetailDto } from './organisation-account-detail.dto';

/** Every field optional — only the fields present are changed. `organisationAccountDetails`, when present, replaces the whole array (not a merge). */
export class UpdateOrganisationDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  nameOfOrg?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  address?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @Matches(/^(?:\+234|0)[789]\d{9}$/, { each: true, message: 'each phone number must be valid' })
  phoneNumbers?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrganisationAccountDetailDto)
  organisationAccountDetails?: OrganisationAccountDetailDto[];

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  briefHistory?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  businessRegNumber?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  cbnLicenseNumber?: string;

  @IsOptional()
  @IsEmail()
  contactEmail?: string;
}
