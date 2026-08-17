import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';

import { EscalationResolution } from '../loan-verification.service';

export class ResolveEscalationDto {
  @IsIn(['OVERRIDE_PASS', 'REJECT_LOAN'])
  resolution!: EscalationResolution;

  /** Mandatory — a compliance exception (OVERRIDE_PASS) or a rejection both need a recorded reason. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  note!: string;
}
