import { IsInt, IsMongoId, IsOptional, Min } from 'class-validator';

export class JournalEntryLineDto {
  @IsMongoId()
  accountId!: string;

  /** Exactly one of debitKobo/creditKobo must be set — validated by assertJournalLinesBalanced, not here (a plain @IsOptional pair can't see its sibling field). */
  @IsOptional()
  @IsInt()
  @Min(1)
  debitKobo?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  creditKobo?: number;
}
