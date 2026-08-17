import { IsBoolean, IsInt, IsNotEmpty, IsString, Min, MaxLength } from 'class-validator';

export class CreateLeaveTypeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name!: string;

  @IsInt()
  @Min(0)
  defaultAnnualAllocationDays!: number;

  @IsBoolean()
  paid!: boolean;
}
