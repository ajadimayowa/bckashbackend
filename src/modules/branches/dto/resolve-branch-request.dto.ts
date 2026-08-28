import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class ResolveBranchRequestDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  note!: string;
}
