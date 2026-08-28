import { IsBoolean, IsOptional } from 'class-validator';

/**
 * PATCH /staff/:id/compliance — an org:manage admin manually signing off on
 * paperwork with no live verification provider behind it (unlike BVN, which
 * goes through POST /staff/:id/verify-bvn instead). Every field optional.
 */
export class UpdateStaffComplianceDto {
  @IsOptional()
  @IsBoolean()
  ninVerified?: boolean;

  @IsOptional()
  @IsBoolean()
  guarantorFormVerified?: boolean;

  @IsOptional()
  @IsBoolean()
  offerLetterVerified?: boolean;
}
