import { Matches } from 'class-validator';

export class VerifyStaffBvnDto {
  @Matches(/^\d{11}$/, { message: 'bvn must be exactly 11 digits' })
  bvn!: string;
}
