import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class InitiateGroupCreationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @IsMongoId()
  branchId!: string;

  /**
   * Order is significant and is never re-sorted downstream: index 0 becomes
   * GROUP_HEAD, index 1 becomes GROUP_HEAD_ASSISTANT, index 2 becomes
   * COORDINATOR, every remaining index becomes a plain MEMBER. Callers must
   * submit this array in the exact order leadership should be assigned —
   * do not reorder it for display or any other purpose before sending it.
   */
  @IsArray()
  @ArrayMinSize(3)
  @IsMongoId({ each: true })
  proposedMemberCustomerIds!: string[];

  // Free-text intake fields — see Group schema's own doc comment for why
  // proposedLeaderName is informational only, not the real leadership
  // assignment mechanism.
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
