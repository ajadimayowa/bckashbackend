import { IsNotEmpty, Matches } from 'class-validator';

/**
 * No fixed length — deliberately not `{11}` (unlike RecordNin's earlier
 * validation and the BVN/phone fields elsewhere) per explicit product
 * direction: the NIN field must not be restricted to a certain length,
 * digits only.
 */
export class RecordNinDto {
  @IsNotEmpty()
  @Matches(/^\d+$/, { message: 'nin must contain digits only' })
  nin!: string;
}
