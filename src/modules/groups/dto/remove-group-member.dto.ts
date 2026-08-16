import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class RemoveGroupMemberDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  @IsNotEmpty()
  reason!: string;
}
