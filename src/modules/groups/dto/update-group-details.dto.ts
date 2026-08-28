import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** PATCH /groups/:groupId/details — every field optional; only what's present is changed. Requires a GRANTED edit privilege (see GroupsService.updateGroupDetails). */
export class UpdateGroupDetailsDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  proposedLeaderName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  meetingDay?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  meetingLocation?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  expectedMemberCount?: number;
}
