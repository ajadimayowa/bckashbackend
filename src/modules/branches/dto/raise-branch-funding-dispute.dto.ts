import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class RaiseBranchFundingDisputeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason!: string;
}
