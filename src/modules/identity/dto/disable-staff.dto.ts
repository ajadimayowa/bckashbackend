import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class DisableStaffDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  @IsNotEmpty()
  reason!: string;
}
