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
import { CreateLoanConfigurationDto } from './dto/create-loan-configuration.dto';
import { LoanConfigurationService } from './loan-configuration.service';
import { LoanConfiguration } from './schemas/loan-configuration.schema';

const INITIATE_LOAN_CONFIG = initiateCapability(WorkflowEntityType.LOAN_CONFIG);

@ApiTags('loan-configurations')
@ApiBearerAuth('access-token')
@Controller('loan-configurations')
@UseGuards(JwtAuthGuard, StaffContextGuard, CapabilityGuard)
export class LoanConfigurationController {
  constructor(private readonly service: LoanConfigurationService) {}

  @Post()
  @RequireCapability(INITIATE_LOAN_CONFIG)
  @ApiOperation({
    summary: 'Propose a new Loan Configuration version',
    description:
      'Admin/SuperAdmin-initiated, workflow-approved. On approval this becomes a brand-new record and ' +
      "whichever version was previously ACTIVE (if any) is flipped to INACTIVE — it isn't edited in place.",
  })
  async create(
    @Body() dto: CreateLoanConfigurationDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<WorkflowRequestSummaryDto> {
    const request = await this.service.initiateCreation(dto, actor.staffId);
    return WorkflowRequestSummaryDto.fromDocument(request);
  }

  // Reads: authenticated-only, no capability gate — same reasoning as
  // LoanProductsController/FeeDefinitionsController.
  @Get()
  @ApiOperation({ summary: 'Every Loan Configuration version, newest first' })
  findAll(): Promise<LoanConfiguration[]> {
    return this.service.findAll();
  }

  // Must precede `@Get(':id')` below — otherwise "active" would be matched as an :id.
  @Get('active')
  @ApiOperation({ summary: 'The currently ACTIVE Loan Configuration, if one has ever been approved' })
  findActive(): Promise<LoanConfiguration | null> {
    return this.service.findActive();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one Loan Configuration version by id' })
  findOne(@Param('id') id: string): Promise<LoanConfiguration | null> {
    return this.service.findById(id);
  }
}
