import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsMongoId,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { JournalEntryLineDto } from './journal-entry-line.dto';

export class ProposeManualJournalEntryDto {
  @IsMongoId()
  branchId!: string;

  @IsDateString()
  date!: string;

  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => JournalEntryLineDto)
  lines!: JournalEntryLineDto[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
