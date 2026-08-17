import { IsDateString, IsMongoId, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class ApplyForLeaveDto {
  @IsMongoId()
  leaveTypeId!: string;

  @IsDateString()
  startDate!: string;

  @IsDateString()
  endDate!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason!: string;
}
