import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class DecideEditPrivilegeDto {
  @IsBoolean()
  approve!: boolean;

  @IsOptional()
  @IsString()
  comment?: string;
}
