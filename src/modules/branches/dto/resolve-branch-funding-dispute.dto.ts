import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class ResolveBranchFundingDisputeDto {
  @IsIn(['RESOLVED', 'DISMISSED'])
  resolution!: 'RESOLVED' | 'DISMISSED';

  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  note!: string;
}
