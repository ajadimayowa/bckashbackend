import { IsNotEmpty, IsString } from 'class-validator';

export class AddRoleCapabilityDto {
  /** e.g. "workflow:initiate:STAFF" — see constants/capabilities.ts for the exact strings a chain actually checks. */
  @IsString()
  @IsNotEmpty()
  capability!: string;
}
