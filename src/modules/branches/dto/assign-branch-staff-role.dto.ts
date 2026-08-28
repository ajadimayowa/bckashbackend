import { ArrayNotEmpty, IsArray, IsIn, IsMongoId, IsOptional, IsString, MaxLength } from 'class-validator';

import { BRANCH_STAFF_ASSIGNMENT_ROLES, BranchStaffAssignmentRole } from '../schemas/branch-staff-role-assignment.schema';

export class AssignBranchStaffRoleDto {
  @IsMongoId()
  staffId!: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsMongoId({ each: true })
  branchIds!: string[];

  @IsIn(BRANCH_STAFF_ASSIGNMENT_ROLES)
  role!: BranchStaffAssignmentRole;

  /** Optional free-text note — e.g. why this admin/approver is being given this coverage. Shown on the assignment's history once approved. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  comments?: string;
}
