import { ArrayUnique, IsArray, IsString } from 'class-validator';

export class UpdateRoleCapabilitiesDto {
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  capabilities!: string[];
}
