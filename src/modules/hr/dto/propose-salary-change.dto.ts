import { Type } from 'class-transformer';
import { IsArray, IsDateString, IsInt, IsMongoId, Min, ValidateNested } from 'class-validator';

import { SalaryAllowanceDto } from './salary-allowance.dto';

export class ProposeSalaryChangeDto {
  @IsMongoId()
  staffId!: string;

  @IsInt()
  @Min(0)
  baseSalaryKobo!: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SalaryAllowanceDto)
  allowances!: SalaryAllowanceDto[];

  @IsDateString()
  effectiveFrom!: string;
}
