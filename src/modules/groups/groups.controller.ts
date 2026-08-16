import { Body, Controller, Get, Param, ParseEnumPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { GroupMemberRole } from '../../common/enums/group.enums';
import { WorkflowEntityType } from '../../common/enums/workflow.enums';
import {
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
import { InitiateGroupCreationDto } from './dto/initiate-group-creation.dto';
import { ReassignLeadershipRoleDto } from './dto/reassign-leadership-role.dto';
import { RemoveGroupMemberDto } from './dto/remove-group-member.dto';
import { GroupLeadership, GroupLoanEligibilityResult, GroupsService } from './groups.service';
import { GroupMembership } from './schemas/group-membership.schema';
import { Group } from './schemas/group.schema';

const INITIATE_GROUP = initiateCapability(WorkflowEntityType.GROUP);
const INITIATE_GROUP_MEMBERSHIP = initiateCapability(WorkflowEntityType.GROUP_MEMBERSHIP);

@ApiTags('groups')
@ApiBearerAuth('access-token')
@Controller('groups')
@UseGuards(JwtAuthGuard, StaffContextGuard, CapabilityGuard)
export class GroupsController {
  constructor(private readonly groupsService: GroupsService) {}

  @Post()
  @RequireCapability(INITIATE_GROUP)
  async create(
    @Body() dto: InitiateGroupCreationDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<WorkflowRequestSummaryDto> {
    const request = await this.groupsService.initiateCreation(dto, actor.staffId);
    return WorkflowRequestSummaryDto.fromDocument(request);
  }

  @Post(':groupId/members')
  @RequireCapability(INITIATE_GROUP_MEMBERSHIP)
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

  @Get(':groupId')
  findOne(@Param('groupId') groupId: string): Promise<Group> {
    return this.groupsService.findById(groupId);
  }

  @Get(':groupId/members')
  getActiveMembers(@Param('groupId') groupId: string): Promise<GroupMembership[]> {
    return this.groupsService.getActiveMembers(groupId);
  }

  @Get(':groupId/leadership')
  getLeadership(@Param('groupId') groupId: string): Promise<GroupLeadership> {
    return this.groupsService.getLeadership(groupId);
  }

  @Get(':groupId/eligibility')
  getEligibility(@Param('groupId') groupId: string): Promise<GroupLoanEligibilityResult> {
    return this.groupsService.isEligibleForLoanApplication(groupId);
  }
}
