import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

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
import { FeeDefinitionResponseDto } from './dto/fee-definition-response.dto';
import { UpdateFeeDefinitionDto } from './dto/update-fee-definition.dto';
import { FeeDefinitionsService } from './fee-definitions.service';

const INITIATE_FEE_DEFINITION = initiateCapability(WorkflowEntityType.FEE_DEFINITION);

@ApiTags('fee-definitions')
@ApiBearerAuth('access-token')
@Controller('fee-definitions')
@UseGuards(JwtAuthGuard, StaffContextGuard, CapabilityGuard)
export class FeeDefinitionsController {
  constructor(private readonly feeDefinitionsService: FeeDefinitionsService) {}

  @Post()
  @RequireCapability(INITIATE_FEE_DEFINITION)
  @ApiOperation({
    summary: 'Propose a new fee definition',
    description: 'Admin-initiated, workflow-approved.',
  })
  async create(
    @Body() dto: CreateFeeDefinitionDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<WorkflowRequestSummaryDto> {
    const request = await this.feeDefinitionsService.initiateCreation(dto, actor.staffId);
    return WorkflowRequestSummaryDto.fromDocument(request);
  }

  @Patch(':id')
  @RequireCapability(INITIATE_FEE_DEFINITION)
  @ApiOperation({ summary: 'Propose an update to an existing fee definition' })
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
  @ApiOperation({
    summary: 'List fee definitions',
    description: 'Optionally filter by category and/or active status.',
  })
  async findAll(
    @Query('category') category?: FeeCategory,
    @Query('active') active?: string,
  ): Promise<FeeDefinitionResponseDto[]> {
    const fees = await this.feeDefinitionsService.findAll({
      category,
      active: active === undefined ? undefined : active === 'true',
    });
    return fees.map((fee) => FeeDefinitionResponseDto.fromDocument(fee));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a fee definition by id' })
  async findOne(@Param('id') id: string): Promise<FeeDefinitionResponseDto> {
    const fee = await this.feeDefinitionsService.findByIdOrThrow(id);
    return FeeDefinitionResponseDto.fromDocument(fee);
  }
}
