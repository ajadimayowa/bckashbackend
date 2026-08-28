import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class RequestGroupEditPrivilegeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}
