import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
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
import { BranchFundBalanceService } from './branch-fund-balance.service';
import { BranchManagerAssignmentService } from './branch-manager-assignment.service';
import { BranchStaffRoleAssignmentService } from './branch-staff-role-assignment.service';
import { BranchesService, BranchStats } from './branches.service';
import { AssignManagerDto } from './dto/assign-manager.dto';
import { BranchActivityEntryDto } from './dto/branch-activity-entry.dto';
import { CreateBranchDto } from './dto/create-branch.dto';
import { UpdateBranchDto } from './dto/update-branch.dto';
import { Branch } from './schemas/branch.schema';
import { BranchManagerAssignment } from './schemas/branch-manager-assignment.schema';
import { BranchStaffAssignmentRole, BranchStaffRoleAssignment } from './schemas/branch-staff-role-assignment.schema';

const INITIATE_BRANCH = initiateCapability(WorkflowEntityType.BRANCH);
// Same tier that approves a branch's creation — the natural gate for
// hard-deleting one too (see BranchesService.deleteBranch's own doc comment).
const APPROVE_BRANCH = approveCapability(WorkflowEntityType.BRANCH);
const INITIATE_BRANCH_MANAGER_ASSIGNMENT = initiateCapability(
  WorkflowEntityType.BRANCH_MANAGER_ASSIGNMENT,
);

@ApiTags('branches')
@ApiBearerAuth('access-token')
@Controller('branches')
@UseGuards(JwtAuthGuard, StaffContextGuard, CapabilityGuard)
export class BranchesController {
  constructor(
    private readonly branchesService: BranchesService,
    private readonly branchManagerAssignmentService: BranchManagerAssignmentService,
    private readonly branchStaffRoleAssignmentService: BranchStaffRoleAssignmentService,
    private readonly branchFundBalanceService: BranchFundBalanceService,
  ) {}

  @Post()
  @RequireCapability(INITIATE_BRANCH)
  @ApiOperation({
    summary: 'Propose a new branch',
    description:
      'Admin/SuperAdmin/Approver-initiated, workflow-approved by a *different* Admin/SuperAdmin/Approver — ' +
      'returns a pending WorkflowRequest, not the branch itself (it does not exist until approved).',
  })
  create(
    @Body() dto: CreateBranchDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<WorkflowRequestSummaryDto> {
    return this.branchesService
      .initiateCreation(dto, actor.staffId)
      .then((request) => WorkflowRequestSummaryDto.fromDocument(request));
  }

  // Reads: authenticated-only, no capability gate — same reasoning as
  // LoanProductsController/FeeDefinitionsController (every staff role needs
  // to look branches up, e.g. onboarding assigns one).
  @Get()
  @ApiOperation({ summary: 'List every branch' })
  findAll(): Promise<Branch[]> {
    return this.branchesService.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a branch by id' })
  findOne(@Param('id') id: string): Promise<Branch> {
    return this.branchesService.findById(id);
  }

  @Patch(':id')
  @RequireCapability(ORG_MANAGE_CAPABILITY)
  @ApiOperation({
    summary: 'Update a branch',
    description: 'Direct/immediate — only *creating* a branch needs a second approver, editing one does not.',
  })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateBranchDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<Branch> {
    return this.branchesService.update(id, dto, actor.staffId);
  }

  @Delete(':id')
  @RequireCapability(APPROVE_BRANCH)
  @ApiOperation({
    summary: 'Hard-delete a branch',
    description:
      'Admin/SuperAdmin/Approver only. Only a branch with nothing (staff, customers, groups, loans) ' +
      'still referencing it can be deleted — active or inactive makes no difference to this check.',
  })
  async remove(
    @Param('id') id: string,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<{ deleted: true }> {
    await this.branchesService.deleteBranch(id, actor.staffId);
    return { deleted: true };
  }

  @Get(':id/activity')
  @ApiOperation({
    summary: "Get a branch's activity trail",
    description:
      'BRANCH_CREATED/ACTIVATED/DEACTIVATED plus its funding verify/reject history, oldest first — ' +
      "doubles as the Manager dashboard's notifications-from-head-office feed.",
  })
  async getActivity(@Param('id') branchId: string): Promise<BranchActivityEntryDto[]> {
    const entries = await this.branchesService.getActivity(branchId);
    const namesById = await this.branchesService.resolveStaffNames(
      entries.map((e) => e.actorId).filter((v): v is string => Boolean(v)),
    );
    return entries.map((entry) =>
      BranchActivityEntryDto.fromDocument(entry, entry.actorId ? (namesById.get(entry.actorId) ?? null) : null),
    );
  }

  @Post(':id/manager')
  @RequireCapability(INITIATE_BRANCH_MANAGER_ASSIGNMENT)
  @ApiOperation({
    summary: 'Propose a branch manager assignment',
    description:
      'Workflow-mediated — a different Admin/SuperAdmin/Approver must approve this before it takes ' +
      'effect (see BranchManagerAssignmentService). Only MANAGER-role, ACTIVE staff can be proposed. ' +
      'Returns a pending WorkflowRequest, not the assignment itself.',
  })
  assignManager(
    @Param('id') branchId: string,
    @Body() dto: AssignManagerDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<WorkflowRequestSummaryDto> {
    return this.branchManagerAssignmentService
      .initiateAssignment(branchId, dto.staffId, dto.comments, actor.staffId)
      .then((request) => WorkflowRequestSummaryDto.fromDocument(request));
  }

  @Get(':id/manager')
  @ApiOperation({
    summary: "Get a branch's current manager",
    description: 'null if no manager is currently assigned.',
  })
  getCurrentManager(@Param('id') branchId: string): Promise<BranchManagerAssignment | null> {
    return this.branchManagerAssignmentService.getCurrentManager(branchId);
  }

  @Get(':id/manager-history')
  @ApiOperation({ summary: "Get a branch's full manager assignment history" })
  getManagerHistory(@Param('id') branchId: string): Promise<BranchManagerAssignment[]> {
    return this.branchManagerAssignmentService.getHistory(branchId);
  }

  @Get(':id/staff-assignments')
  @ApiOperation({
    summary: "Get a branch's currently-assigned ADMIN/APPROVER staff",
    description: 'Optionally filtered by ?role=ADMIN|APPROVER. Empty array if nobody is currently assigned.',
  })
  getStaffAssignments(
    @Param('id') branchId: string,
    @Query('role') role?: BranchStaffAssignmentRole,
  ): Promise<BranchStaffRoleAssignment[]> {
    return this.branchStaffRoleAssignmentService.getStaffForBranch(branchId, role);
  }

  @Get(':id/staff-assignments-history')
  @ApiOperation({ summary: "Get a branch's full ADMIN/APPROVER coverage history" })
  getStaffAssignmentsHistory(@Param('id') branchId: string): Promise<BranchStaffRoleAssignment[]> {
    return this.branchStaffRoleAssignmentService.getHistory({ branchId });
  }

  @Get(':id/stats')
  @ApiOperation({
    summary: "Get a branch's staff and active-loan counts",
    description: 'staffCount is every Staff record with this branchId; activeLoansCount is loans currently DISBURSED.',
  })
  getStats(@Param('id') branchId: string): Promise<BranchStats> {
    return this.branchesService.getStats(branchId);
  }

  @Get(':id/balance')
  @ApiOperation({
    summary: "Get a branch's available fund balance",
    description:
      'The real-time balance loan disbursements draw down against — see branch-funding for how it gets topped up.',
  })
  async getBalance(
    @Param('id') branchId: string,
  ): Promise<{ branchId: string; availableAmount: number }> {
    const availableAmount = await this.branchFundBalanceService.getBalance(branchId);
    return { branchId, availableAmount };
  }
}
