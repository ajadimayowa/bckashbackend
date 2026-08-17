import { IsBoolean, IsInt, IsOptional, IsString, Min, MaxLength } from 'class-validator';

export class UpdateLeaveTypeDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  defaultAnnualAllocationDays?: number;

  @IsOptional()
  @IsBoolean()
  paid?: boolean;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
