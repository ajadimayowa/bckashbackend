import { IsBoolean, IsEnum, IsInt, Max, Min } from 'class-validator';

import { RepaymentFrequency } from '../../../common/enums/platform-config.enums';

export class CreateRepaymentPenaltyConfigurationDto {
  /** Basis points (250 = 2.50%). */
  @IsInt()
  @Min(0)
  @Max(100_000)
  penaltyRate!: number;

  @IsInt()
  @Min(0)
  penaltyGracePeriodDays!: number;

  /** Basis points (2500 = 25.00%). */
  @IsInt()
  @Min(0)
  @Max(100_000)
  maxPenaltyCap!: number;

  @IsBoolean()
  autoPenalty!: boolean;

  @IsEnum(RepaymentFrequency)
  repaymentFrequency!: RepaymentFrequency;
}
