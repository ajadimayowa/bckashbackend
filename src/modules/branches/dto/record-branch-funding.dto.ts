import {
  IsInt,
  IsISO8601,
  IsMongoId,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
} from 'class-validator';

export class RecordBranchFundingDto {
  @IsMongoId()
  branchId!: string;

  /** Must be this branch's currently-*active* bank account — see BranchFundingService.recordFunding. */
  @IsMongoId()
  bankAccountId!: string;

  /** Kobo — integer, never a float (project-wide convention). */
  @IsInt()
  @IsPositive()
  amount!: number;

  @IsISO8601()
  fundedAt!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;
}
