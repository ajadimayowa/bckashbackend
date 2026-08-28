import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { WorkflowEntityType } from '../../common/enums/workflow.enums';
import {
  approveCapability,
  initiateCapability,
  ORG_MANAGE_CAPABILITY,
} from '../../platform/rbac/constants/capabilities';
import { CurrentStaffContext } from '../../platform/rbac/decorators/current-staff-context.decorator';
import { RequireCapability } from '../../platform/rbac/decorators/require-capability.decorator';
import { CapabilityGuard } from '../../platform/rbac/guards/capability.guard';
import { StaffContextGuard } from '../../platform/rbac/guards/staff-context.guard';
import type { ResolvedStaffContext } from '../../platform/rbac/interfaces/staff-context.interface';
import { WorkflowRequestSummaryDto } from '../../platform/workflow-engine/dto/workflow-request-summary.dto';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { BranchStaffRoleAssignmentService } from './branch-staff-role-assignment.service';
import { AssignBranchStaffRoleDto } from './dto/assign-branch-staff-role.dto';
import { RevokeBranchStaffRoleDto } from './dto/revoke-branch-staff-role.dto';
import { BranchStaffRoleAssignment } from './schemas/branch-staff-role-assignment.schema';

const INITIATE_BRANCH_ROLE_ASSIGNMENT = initiateCapability(WorkflowEntityType.BRANCH_ROLE_ASSIGNMENT);
const APPROVE_BRANCH_ROLE_ASSIGNMENT = approveCapability(WorkflowEntityType.BRANCH_ROLE_ASSIGNMENT);

/**
 * Staff-fixed, branches-variable — the inverse shape of
 * `POST /branches/:id/manager` (branch-fixed, staff-variable), so this
 * deliberately lives at its own `branches/staff-assignments` prefix rather
 * than nested under `/branches/:id`. Read-by-branch endpoints (which ARE
 * branch-fixed) stay on `BranchesController` instead — see
 * `GET /branches/:id/staff-assignments`.
 */
@ApiTags('branches')
@ApiBearerAuth('access-token')
@Controller('branches/staff-assignments')
@UseGuards(JwtAuthGuard, StaffContextGuard, CapabilityGuard)
export class BranchStaffRoleAssignmentController {
  constructor(private readonly assignmentService: BranchStaffRoleAssignmentService) {}

  @Post()
  @RequireCapability(INITIATE_BRANCH_ROLE_ASSIGNMENT)
  @ApiOperation({
    summary: 'Propose assigning an ADMIN/APPROVER to cover one or more branches',
    description:
      'Workflow-mediated — a different Admin/SuperAdmin/Approver must approve this before it takes ' +
      'effect. One proposal covers the whole batch of branchIds; one approve/reject decision applies ' +
      'to all of them. Returns a pending WorkflowRequest, not the assignment itself.',
  })
  assign(
    @Body() dto: AssignBranchStaffRoleDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<WorkflowRequestSummaryDto> {
    return this.assignmentService
      .initiateAssignment(dto.staffId, dto.branchIds, dto.role, dto.comments, actor.staffId)
      .then((request) => WorkflowRequestSummaryDto.fromDocument(request));
  }

  @Post('revoke')
  @RequireCapability(APPROVE_BRANCH_ROLE_ASSIGNMENT)
  @ApiOperation({
    summary: "Revoke a staff member's coverage of one branch",
    description: 'Direct/immediate — only granting coverage needs a second approver, revoking it does not.',
  })
  revoke(
    @Body() dto: RevokeBranchStaffRoleDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<BranchStaffRoleAssignment> {
    return this.assignmentService.revokeAssignment(dto.staffId, dto.branchId, dto.role, actor.staffId, dto.reason);
  }

  @Get('me')
  @ApiOperation({ summary: 'Get my own current branch coverage — authenticated-only, no capability gate.' })
  getMine(@CurrentStaffContext() actor: ResolvedStaffContext): Promise<BranchStaffRoleAssignment[]> {
    return this.assignmentService.getBranchesForStaff(actor.staffId);
  }

  @Get('staff/:staffId')
  @RequireCapability(ORG_MANAGE_CAPABILITY)
  @ApiOperation({ summary: "Get a staff member's current branch coverage" })
  getForStaff(@Param('staffId') staffId: string): Promise<BranchStaffRoleAssignment[]> {
    return this.assignmentService.getBranchesForStaff(staffId);
  }
}
