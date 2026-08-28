import { IsInt, Max, Min } from 'class-validator';

export class CreateLoanConfigurationDto {
  /** Annual rate, basis points (2400 = 24.00%). */
  @IsInt()
  @Min(0)
  @Max(100_000)
  interestRate!: number;

  @IsInt()
  @Min(0)
  maxLoanAmountKobo!: number;

  @IsInt()
  @Min(0)
  minLoanAmountKobo!: number;

  @IsInt()
  @Min(1)
  maxTenureMonths!: number;

  @IsInt()
  @Min(0)
  gracePeriodDays!: number;

  @IsInt()
  @Min(1)
  maxGroupSize!: number;

  @IsInt()
  @Min(1)
  minGroupSize!: number;
}
