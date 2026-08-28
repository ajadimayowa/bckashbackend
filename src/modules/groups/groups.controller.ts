import { Body, Controller, Delete, Get, Param, ParseEnumPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { GroupMemberRole } from '../../common/enums/group.enums';
import { WorkflowEntityType } from '../../common/enums/workflow.enums';
import {
  approveCapability,
  GROUP_REASSIGN_LEADERSHIP_CAPABILITY,
  initiateCapability,
} from '../../platform/rbac/constants/capabilities';
import { CurrentStaffContext } from '../../platform/rbac/decorators/current-staff-context.decorator';
import { RequireCapability } from '../../platform/rbac/decorators/require-capability.decorator';
import { CapabilityGuard } from '../../platform/rbac/guards/capability.guard';
import { StaffContextGuard } from '../../platform/rbac/guards/staff-context.guard';
import type { ResolvedStaffContext } from '../../platform/rbac/interfaces/staff-context.interface';
import { WorkflowRequestSummaryDto } from '../../platform/workflow-engine/dto/workflow-request-summary.dto';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { AddGroupMemberDto } from './dto/add-group-member.dto';
import { DecideGroupEditPrivilegeDto } from './dto/decide-group-edit-privilege.dto';
import { GroupResponseDto } from './dto/group-response.dto';
import { InitiateGroupCreationDto } from './dto/initiate-group-creation.dto';
import { ReassignLeadershipRoleDto } from './dto/reassign-leadership-role.dto';
import { RemoveGroupMemberDto } from './dto/remove-group-member.dto';
import { RequestGroupEditPrivilegeDto } from './dto/request-group-edit-privilege.dto';
import { UpdateGroupDetailsDto } from './dto/update-group-details.dto';
import { GroupLeadership, GroupLoanEligibilityResult, GroupsService } from './groups.service';
import { GroupMembership } from './schemas/group-membership.schema';

const INITIATE_GROUP = initiateCapability(WorkflowEntityType.GROUP);
const INITIATE_GROUP_MEMBERSHIP = initiateCapability(WorkflowEntityType.GROUP_MEMBERSHIP);
const APPROVE_GROUP = approveCapability(WorkflowEntityType.GROUP);

@ApiTags('groups')
@ApiBearerAuth('access-token')
@Controller('groups')
@UseGuards(JwtAuthGuard, StaffContextGuard, CapabilityGuard)
export class GroupsController {
  constructor(private readonly groupsService: GroupsService) {}

  @Post()
  @RequireCapability(INITIATE_GROUP)
  @ApiOperation({
    summary: 'Initiate group creation',
    description: 'Workflow-mediated — the Group only exists once approved.',
  })
  async create(
    @Body() dto: InitiateGroupCreationDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<WorkflowRequestSummaryDto> {
    const request = await this.groupsService.initiateCreation(dto, actor.staffId);
    return WorkflowRequestSummaryDto.fromDocument(request);
  }

  // Declared before ':groupId/...' routes below — a literal path segment
  // ('requests') must precede a dynamic one at the same position, same
  // convention used elsewhere in this codebase (workflow-requests, branches).
  @Post('requests/:workflowRequestId/resubmit')
  @RequireCapability(INITIATE_GROUP)
  @ApiOperation({
    summary: 'Revise and resubmit a REJECTED group proposal',
    description: 'Maker only. Starts a fresh review cycle (always restarts from the review step).',
  })
  async reviseAndResubmit(
    @Param('workflowRequestId') workflowRequestId: string,
    @Body() dto: InitiateGroupCreationDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<WorkflowRequestSummaryDto> {
    const request = await this.groupsService.reviseAndResubmit(workflowRequestId, actor.staffId, dto);
    return WorkflowRequestSummaryDto.fromDocument(request);
  }

  // Same route-ordering note as 'requests/:workflowRequestId/resubmit' above.
  @Patch('requests/:workflowRequestId')
  @RequireCapability(INITIATE_GROUP)
  @ApiOperation({
    summary: "Edit a PENDING_REVIEW group proposal's details",
    description:
      'Maker only, and only before anyone has reviewed it yet — see reviseAndResubmit for the ' +
      'REJECTED/RETURNED_TO_MAKER counterpart (which restarts the review chain; this does not).',
  })
  async updateProposal(
    @Param('workflowRequestId') workflowRequestId: string,
    @Body() dto: InitiateGroupCreationDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<WorkflowRequestSummaryDto> {
    const request = await this.groupsService.updateProposal(workflowRequestId, actor.staffId, dto);
    return WorkflowRequestSummaryDto.fromDocument(request);
  }

  // Same route-ordering note as 'requests/:workflowRequestId/resubmit' above.
  @Delete('requests/:workflowRequestId')
  @RequireCapability(INITIATE_GROUP)
  @ApiOperation({
    summary: 'Permanently delete a PENDING_REVIEW or REJECTED group proposal',
    description:
      'Maker only. Also hard-deletes every proposed member Customer record still in a deletable ' +
      "state (see CustomerService.deleteCustomer) — a record already gone ACTIVE, or created by " +
      'someone else, is left untouched.',
  })
  async deleteProposal(
    @Param('workflowRequestId') workflowRequestId: string,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<{ deleted: true }> {
    await this.groupsService.deleteProposal(workflowRequestId, actor.staffId);
    return { deleted: true };
  }

  @Post(':groupId/members')
  @RequireCapability(INITIATE_GROUP_MEMBERSHIP)
  @ApiOperation({ summary: 'Initiate adding a member to an existing group' })
  async addMember(
    @Param('groupId') groupId: string,
    @Body() dto: AddGroupMemberDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<WorkflowRequestSummaryDto> {
    const request = await this.groupsService.initiateMemberAddition(groupId, dto, actor.staffId);
    return WorkflowRequestSummaryDto.fromDocument(request);
  }

  @Post(':groupId/members/:customerId/remove')
  @RequireCapability(INITIATE_GROUP_MEMBERSHIP)
  @ApiOperation({
    summary: 'Initiate removing a member from a group',
    description: 'Blocked if the member has a pending loan.',
  })
  async removeMember(
    @Param('groupId') groupId: string,
    @Param('customerId') customerId: string,
    @Body() dto: RemoveGroupMemberDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<WorkflowRequestSummaryDto> {
    const request = await this.groupsService.initiateMemberRemoval(
      groupId,
      customerId,
      dto.reason,
      actor.staffId,
    );
    return WorkflowRequestSummaryDto.fromDocument(request);
  }

  @Post(':groupId/leadership/:role')
  @RequireCapability(GROUP_REASSIGN_LEADERSHIP_CAPABILITY)
  @ApiOperation({
    summary: 'Reassign a group leadership role',
    description: 'Corrective admin action for a vacant/disputed role — Admin/SuperAdmin only.',
  })
  async reassignLeadership(
    @Param('groupId') groupId: string,
    @Param('role', new ParseEnumPipe(GroupMemberRole)) role: GroupMemberRole,
    @Body() dto: ReassignLeadershipRoleDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<WorkflowRequestSummaryDto> {
    const request = await this.groupsService.reassignLeadershipRole(
      groupId,
      role,
      dto.newCustomerId,
      actor.staffId,
    );
    return WorkflowRequestSummaryDto.fromDocument(request);
  }

  // ---------------------------------------------------------------------------
  // Reads — deliberately no @RequireCapability beyond authentication; group
  // composition/eligibility isn't PII and every staff role has a legitimate
  // reason to view it (a reviewer/approver of a future loan application needs
  // this just as much as the marketer who built the group). See PHASE_6_NOTES.md.
  // ---------------------------------------------------------------------------

  @Get()
  @ApiOperation({
    summary: 'List groups',
    description:
      'Row-scoped exactly like GET /customers: ADMIN/SUPERADMIN/APPROVER see every group ' +
      '(optionally filtered by branchId); a MANAGER only sees their own branch; anyone else ' +
      '(MARKETER) only sees groups they themselves created.',
  })
  async findAll(
    @Query('branchId') branchId: string | undefined,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<GroupResponseDto[]> {
    const groups = await this.groupsService.findAllForActor({ branchId }, actor);
    const branchNamesById = await this.groupsService.resolveBranchNames(
      groups.map((g) => g.branchId.toString()),
    );
    return groups.map((group) =>
      GroupResponseDto.fromDocument(group, branchNamesById.get(group.branchId.toString()) ?? null),
    );
  }

  @Get(':groupId')
  @ApiOperation({ summary: 'Get a group by id' })
  async findOne(@Param('groupId') groupId: string): Promise<GroupResponseDto> {
    const group = await this.groupsService.findById(groupId);
    const branchNamesById = await this.groupsService.resolveBranchNames([group.branchId.toString()]);
    return GroupResponseDto.fromDocument(group, branchNamesById.get(group.branchId.toString()) ?? null);
  }

  @Get(':groupId/members')
  @ApiOperation({ summary: "List a group's active members" })
  getActiveMembers(@Param('groupId') groupId: string): Promise<GroupMembership[]> {
    return this.groupsService.getActiveMembers(groupId);
  }

  @Get(':groupId/leadership')
  @ApiOperation({ summary: "Get a group's current leadership roles" })
  getLeadership(@Param('groupId') groupId: string): Promise<GroupLeadership> {
    return this.groupsService.getLeadership(groupId);
  }

  @Get(':groupId/eligibility')
  @ApiOperation({ summary: 'Check whether a group is eligible to raise a loan application' })
  getEligibility(@Param('groupId') groupId: string): Promise<GroupLoanEligibilityResult> {
    return this.groupsService.isEligibleForLoanApplication(groupId);
  }

  // ---------------------------------------------------------------------------
  // Edit privilege — see GroupsService's own doc comment above requestEditPrivilege.
  // ---------------------------------------------------------------------------

  @Post(':groupId/edit-privilege/request')
  @RequireCapability(INITIATE_GROUP)
  @ApiOperation({
    summary: "Request permission to edit an already-approved group's intake details",
    description:
      'Creator only, ACTIVE groups only. Only Admin/SuperAdmin/Approver can grant it ' +
      '(see POST :groupId/edit-privilege/decide).',
  })
  async requestEditPrivilege(
    @Param('groupId') groupId: string,
    @Body() dto: RequestGroupEditPrivilegeDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<GroupResponseDto> {
    const group = await this.groupsService.requestEditPrivilege(groupId, dto.reason, actor.staffId);
    const branchNamesById = await this.groupsService.resolveBranchNames([group.branchId.toString()]);
    return GroupResponseDto.fromDocument(group, branchNamesById.get(group.branchId.toString()) ?? null);
  }

  @Post(':groupId/edit-privilege/decide')
  @RequireCapability(APPROVE_GROUP)
  @ApiOperation({ summary: 'Grant or reject a pending edit privilege request' })
  async decideEditPrivilege(
    @Param('groupId') groupId: string,
    @Body() dto: DecideGroupEditPrivilegeDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<GroupResponseDto> {
    const group = await this.groupsService.decideEditPrivilege(groupId, dto.approve, dto.comment, actor.staffId);
    const branchNamesById = await this.groupsService.resolveBranchNames([group.branchId.toString()]);
    return GroupResponseDto.fromDocument(group, branchNamesById.get(group.branchId.toString()) ?? null);
  }

  @Patch(':groupId/details')
  @RequireCapability(INITIATE_GROUP)
  @ApiOperation({
    summary: "Update an ACTIVE group's intake details",
    description: 'Creator only, and only once edit privilege has been GRANTED (see POST :groupId/edit-privilege/request).',
  })
  async updateDetails(
    @Param('groupId') groupId: string,
    @Body() dto: UpdateGroupDetailsDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<GroupResponseDto> {
    const group = await this.groupsService.updateGroupDetails(groupId, actor.staffId, dto);
    const branchNamesById = await this.groupsService.resolveBranchNames([group.branchId.toString()]);
    return GroupResponseDto.fromDocument(group, branchNamesById.get(group.branchId.toString()) ?? null);
  }
}
