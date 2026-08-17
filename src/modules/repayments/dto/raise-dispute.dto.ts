import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class RaiseDisputeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason!: string;
}
