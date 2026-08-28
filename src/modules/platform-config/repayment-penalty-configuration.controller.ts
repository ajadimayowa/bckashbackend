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
import { CreateRepaymentPenaltyConfigurationDto } from './dto/create-repayment-penalty-configuration.dto';
import { RepaymentPenaltyConfigurationService } from './repayment-penalty-configuration.service';
import { RepaymentPenaltyConfiguration } from './schemas/repayment-penalty-configuration.schema';

const INITIATE_REPAYMENT_PENALTY_CONFIG = initiateCapability(WorkflowEntityType.REPAYMENT_PENALTY_CONFIG);

@ApiTags('repayment-penalty-configurations')
@ApiBearerAuth('access-token')
@Controller('repayment-penalty-configurations')
@UseGuards(JwtAuthGuard, StaffContextGuard, CapabilityGuard)
export class RepaymentPenaltyConfigurationController {
  constructor(private readonly service: RepaymentPenaltyConfigurationService) {}

  @Post()
  @RequireCapability(INITIATE_REPAYMENT_PENALTY_CONFIG)
  @ApiOperation({
    summary: 'Propose a new Repayment & Penalties Configuration version',
    description: 'Admin/SuperAdmin-initiated, workflow-approved — see LoanConfigurationController for the versioning shape.',
  })
  async create(
    @Body() dto: CreateRepaymentPenaltyConfigurationDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<WorkflowRequestSummaryDto> {
    const request = await this.service.initiateCreation(dto, actor.staffId);
    return WorkflowRequestSummaryDto.fromDocument(request);
  }

  @Get()
  @ApiOperation({ summary: 'Every Repayment & Penalties Configuration version, newest first' })
  findAll(): Promise<RepaymentPenaltyConfiguration[]> {
    return this.service.findAll();
  }

  // Must precede `@Get(':id')` below — otherwise "active" would be matched as an :id.
  @Get('active')
  @ApiOperation({ summary: 'The currently ACTIVE Repayment & Penalties Configuration, if one has ever been approved' })
  findActive(): Promise<RepaymentPenaltyConfiguration | null> {
    return this.service.findActive();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one Repayment & Penalties Configuration version by id' })
  findOne(@Param('id') id: string): Promise<RepaymentPenaltyConfiguration | null> {
    return this.service.findById(id);
  }
}
