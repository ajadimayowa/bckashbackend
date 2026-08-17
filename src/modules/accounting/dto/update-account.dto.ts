import { IsBoolean, IsMongoId, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/** Every field optional — only the fields present are changed. `code`/`type` are deliberately not editable — see AccountingService's own reasoning (a code/type change would invalidate historical postings' meaning). */
export class UpdateAccountDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsMongoId()
  parentAccountId?: string | null;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
