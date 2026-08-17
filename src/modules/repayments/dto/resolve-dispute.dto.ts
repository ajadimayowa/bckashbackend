import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class ResolveDisputeDto {
  @IsIn(['APPROVED', 'REJECTED'])
  resolution!: 'APPROVED' | 'REJECTED';

  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  note!: string;
}
