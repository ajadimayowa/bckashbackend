import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { WorkflowEntityType } from '../../common/enums/workflow.enums';
import { initiateCapability } from '../../platform/rbac/constants/capabilities';
import { CurrentStaffContext } from '../../platform/rbac/decorators/current-staff-context.decorator';
import { RequireCapability } from '../../platform/rbac/decorators/require-capability.decorator';
import { CapabilityGuard } from '../../platform/rbac/guards/capability.guard';
import { StaffContextGuard } from '../../platform/rbac/guards/staff-context.guard';
import type { ResolvedStaffContext } from '../../platform/rbac/interfaces/staff-context.interface';
import { WorkflowRequestSummaryDto } from '../../platform/workflow-engine/dto/workflow-request-summary.dto';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { BranchRulesConfigurationService } from './branch-rules-configuration.service';
import { CreateBranchRulesConfigurationDto } from './dto/create-branch-rules-configuration.dto';
import { BranchRulesConfiguration } from './schemas/branch-rules-configuration.schema';

const INITIATE_BRANCH_RULES_CONFIG = initiateCapability(WorkflowEntityType.BRANCH_RULES_CONFIG);

@ApiTags('branch-rules-configurations')
@ApiBearerAuth('access-token')
@Controller('branch-rules-configurations')
@UseGuards(JwtAuthGuard, StaffContextGuard, CapabilityGuard)
export class BranchRulesConfigurationController {
  constructor(private readonly service: BranchRulesConfigurationService) {}

  @Post()
  @RequireCapability(INITIATE_BRANCH_RULES_CONFIG)
  @ApiOperation({
    summary: 'Propose a new Branch Rules Configuration version',
    description: 'Admin/SuperAdmin-initiated, workflow-approved — see LoanConfigurationController for the versioning shape.',
  })
  async create(
    @Body() dto: CreateBranchRulesConfigurationDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<WorkflowRequestSummaryDto> {
    const request = await this.service.initiateCreation(dto, actor.staffId);
    return WorkflowRequestSummaryDto.fromDocument(request);
  }

  @Get()
  @ApiOperation({ summary: 'Every Branch Rules Configuration version, newest first' })
  findAll(): Promise<BranchRulesConfiguration[]> {
    return this.service.findAll();
  }

  // Must precede `@Get(':id')` below — otherwise "active" would be matched as an :id.
  @Get('active')
  @ApiOperation({ summary: 'The currently ACTIVE Branch Rules Configuration, if one has ever been approved' })
  findActive(): Promise<BranchRulesConfiguration | null> {
    return this.service.findActive();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one Branch Rules Configuration version by id' })
  findOne(@Param('id') id: string): Promise<BranchRulesConfiguration | null> {
    return this.service.findById(id);
  }
}
