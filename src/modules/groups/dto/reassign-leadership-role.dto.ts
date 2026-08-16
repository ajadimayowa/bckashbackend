import { IsMongoId } from 'class-validator';

/** `role` comes from the route param (validated via ParseEnumPipe), not the body. */
export class ReassignLeadershipRoleDto {
  @IsMongoId()
  newCustomerId!: string;
}
