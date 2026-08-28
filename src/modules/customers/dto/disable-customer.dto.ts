import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class DisableCustomerDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  @IsNotEmpty()
  reason!: string;
}
