import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { FeeCategory } from '../../common/enums/loan-product.enums';
import { WorkflowEntityType } from '../../common/enums/workflow.enums';
import { initiateCapability } from '../../platform/rbac/constants/capabilities';
import { CurrentStaffContext } from '../../platform/rbac/decorators/current-staff-context.decorator';
import { RequireCapability } from '../../platform/rbac/decorators/require-capability.decorator';
import { CapabilityGuard } from '../../platform/rbac/guards/capability.guard';
import { StaffContextGuard } from '../../platform/rbac/guards/staff-context.guard';
import type { ResolvedStaffContext } from '../../platform/rbac/interfaces/staff-context.interface';
import { WorkflowRequestSummaryDto } from '../../platform/workflow-engine/dto/workflow-request-summary.dto';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { CreateFeeDefinitionDto } from './dto/create-fee-definition.dto';
import { UpdateFeeDefinitionDto } from './dto/update-fee-definition.dto';
import { FeeDefinitionsService } from './fee-definitions.service';
import { FeeDefinition } from './schemas/fee-definition.schema';

const INITIATE_FEE_DEFINITION = initiateCapability(WorkflowEntityType.FEE_DEFINITION);

@ApiTags('fee-definitions')
@ApiBearerAuth('access-token')
@Controller('fee-definitions')
@UseGuards(JwtAuthGuard, StaffContextGuard, CapabilityGuard)
export class FeeDefinitionsController {
  constructor(private readonly feeDefinitionsService: FeeDefinitionsService) {}

  @Post()
  @RequireCapability(INITIATE_FEE_DEFINITION)
  async create(
    @Body() dto: CreateFeeDefinitionDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<WorkflowRequestSummaryDto> {
    const request = await this.feeDefinitionsService.initiateCreation(dto, actor.staffId);
    return WorkflowRequestSummaryDto.fromDocument(request);
  }

  @Patch(':id')
  @RequireCapability(INITIATE_FEE_DEFINITION)
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateFeeDefinitionDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<WorkflowRequestSummaryDto> {
    const request = await this.feeDefinitionsService.initiateUpdate(id, dto, actor.staffId);
    return WorkflowRequestSummaryDto.fromDocument(request);
  }

  // Reads: authenticated-only, no capability gate — every staff role that
  // will ever initiate a loan (Phase 8) needs to see available fees. See
  // PHASE_7_NOTES.md.
  @Get()
  findAll(
    @Query('category') category?: FeeCategory,
    @Query('active') active?: string,
  ): Promise<FeeDefinition[]> {
    return this.feeDefinitionsService.findAll({
      category,
      active: active === undefined ? undefined : active === 'true',
    });
  }

  @Get(':id')
  findOne(@Param('id') id: string): Promise<FeeDefinition> {
    return this.feeDefinitionsService.findByIdOrThrow(id);
  }
}
