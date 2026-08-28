import { Transform } from 'class-transformer';
import { IsOptional, Matches, ValidateNested } from 'class-validator';

import { parseJsonFieldAsInstance } from '../../../common/upload/parse-json-field.util';
import { ContactPersonDto } from './contact-person.dto';
import { ResidentialAddressDto } from './residential-address.dto';

/**
 * PATCH /staff/me — a staff member editing their own contact/personal
 * details. Deliberately excludes everything org-managed (role, department,
 * unit, branch, email, moduleAccess, status) and everything already served
 * by its own dedicated, capability-gated endpoint (BVN via
 * POST /staff/:id/verify-bvn, documents via PATCH /staff/:id/documents) —
 * this is self-service for just the handful of fields a person reasonably
 * owns about themselves. Every field optional: send only what's changing.
 */
export class UpdateOwnStaffProfileDto {
  @IsOptional()
  @Matches(/^(?:\+234|0)[789]\d{9}$/, {
    message: 'phoneNumber must be a valid Nigerian mobile number',
  })
  phoneNumber?: string;

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
  @Transform(parseJsonFieldAsInstance(ContactPersonDto))
  @ValidateNested()
  nextOfKin?: ContactPersonDto;

  @IsOptional()
  @Transform(parseJsonFieldAsInstance(ContactPersonDto))
  @ValidateNested()
  reference?: ContactPersonDto;
}
