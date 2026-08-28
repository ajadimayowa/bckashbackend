import { IsBoolean, IsInt, Min } from 'class-validator';

export class CreateBranchRulesConfigurationDto {
  @IsInt()
  @Min(1)
  maxActiveBranches!: number;

  @IsInt()
  @Min(0)
  defaultFundLimitKobo!: number;

  @IsBoolean()
  requireManagerApproval!: boolean;

  @IsInt()
  @Min(0)
  autoDisbursementLimitKobo!: number;
}
