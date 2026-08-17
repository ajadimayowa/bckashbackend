import { IsInt, IsNotEmpty, IsString, Min } from 'class-validator';

export class SalaryAllowanceDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsInt()
  @Min(0)
  amountKobo!: number;
}
