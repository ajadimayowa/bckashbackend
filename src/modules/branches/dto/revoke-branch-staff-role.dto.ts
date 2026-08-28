import { IsIn, IsMongoId, IsOptional, IsString, MaxLength } from 'class-validator';

import { BRANCH_STAFF_ASSIGNMENT_ROLES, BranchStaffAssignmentRole } from '../schemas/branch-staff-role-assignment.schema';

export class RevokeBranchStaffRoleDto {
  @IsMongoId()
  staffId!: string;

  @IsMongoId()
  branchId!: string;

  @IsIn(BRANCH_STAFF_ASSIGNMENT_ROLES)
  role!: BranchStaffAssignmentRole;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
