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

/**
 * `cacDoc` isn't a field here — the CAC document is a file, uploaded (and
 * optional, per the brief) via the separate `POST /organisation/cac-doc`
 * multipart endpoint, same "file upload gets its own endpoint" convention
 * as CustomerController.captureBiometric / RepaymentsController's proof
 * upload. Every field below IS required — the brief only called out cacDoc
 * as optional, so everything else is treated as mandatory for the org's
 * one-time initial setup.
 */
export class CreateOrganisationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  nameOfOrg!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  address!: string;

  // Nigerian mobile format: 0xxxxxxxxxx or +234xxxxxxxxxx — same pattern used
  // throughout identity/customers (kept dependency-free, no libphonenumber).
  @IsArray()
  @ArrayMinSize(1)
  @Matches(/^(?:\+234|0)[789]\d{9}$/, { each: true, message: 'each phone number must be valid' })
  phoneNumbers!: string[];

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrganisationAccountDetailDto)
  organisationAccountDetails!: OrganisationAccountDetailDto[];

  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  briefHistory!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  businessRegNumber!: string;

  /** Optional — not every deployment has this on hand at initial setup time. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  cbnLicenseNumber?: string;

  @IsOptional()
  @IsEmail()
  contactEmail?: string;
}
