import { IsMongoId, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateUnitDto {
  @IsMongoId()
  departmentId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;
}
