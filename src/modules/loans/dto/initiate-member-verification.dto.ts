import { IsMongoId, IsOptional } from 'class-validator';

/** Sent alongside the multipart `liveImage` file — see loans.controller.ts. */
export class InitiateMemberVerificationDto {
  @IsOptional()
  @IsMongoId()
  officeId?: string;

  @IsOptional()
  @IsMongoId()
  officerId?: string;
}
