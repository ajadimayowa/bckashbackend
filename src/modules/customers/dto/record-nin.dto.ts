import { Matches } from 'class-validator';

export class RecordNinDto {
  @Matches(/^\d{11}$/, { message: 'nin must be exactly 11 digits' })
  nin!: string;
}
