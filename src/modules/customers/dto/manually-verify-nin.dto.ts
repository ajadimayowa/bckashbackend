import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ManuallyVerifyNinDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
