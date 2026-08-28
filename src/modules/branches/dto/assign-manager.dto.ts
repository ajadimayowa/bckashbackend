import { IsMongoId, IsOptional, IsString, MaxLength } from 'class-validator';

export class AssignManagerDto {
  @IsMongoId()
  staffId!: string;

  /** Optional free-text note — e.g. why this manager, or why the current one is being replaced. Shown on the branch's Manager Records history once approved. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  comments?: string;
}
