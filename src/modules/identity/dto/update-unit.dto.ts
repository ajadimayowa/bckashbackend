import { IsBoolean, IsMongoId, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateUnitDto {
  @IsOptional()
  @IsMongoId()
  departmentId?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
