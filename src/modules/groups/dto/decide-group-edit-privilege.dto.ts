import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class DecideGroupEditPrivilegeDto {
  @IsBoolean()
  approve!: boolean;

  @IsOptional()
  @IsString()
  comment?: string;
}
