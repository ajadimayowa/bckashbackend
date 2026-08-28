import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ProductStatus } from '../../common/enums/loan-product.enums';
import { WorkflowEntityType } from '../../common/enums/workflow.enums';
import { initiateCapability } from '../../platform/rbac/constants/capabilities';
import { CurrentStaffContext } from '../../platform/rbac/decorators/current-staff-context.decorator';
import { RequireCapability } from '../../platform/rbac/decorators/require-capability.decorator';
import { CapabilityGuard } from '../../platform/rbac/guards/capability.guard';
import { StaffContextGuard } from '../../platform/rbac/guards/staff-context.guard';
import type { ResolvedStaffContext } from '../../platform/rbac/interfaces/staff-context.interface';
import { WorkflowRequestSummaryDto } from '../../platform/workflow-engine/dto/workflow-request-summary.dto';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { CreateLoanProductDto } from './dto/create-loan-product.dto';
import { LoanProductResponseDto } from './dto/loan-product-response.dto';
import { UpdateLoanProductDto } from './dto/update-loan-product.dto';
import { LoanProductsService } from './loan-products.service';

const INITIATE_LOAN_PRODUCT = initiateCapability(WorkflowEntityType.LOAN_PRODUCT);

@ApiTags('loan-products')
@ApiBearerAuth('access-token')
@Controller('loan-products')
@UseGuards(JwtAuthGuard, StaffContextGuard, CapabilityGuard)
export class LoanProductsController {
  constructor(private readonly loanProductsService: LoanProductsService) {}

  @Post()
  @RequireCapability(INITIATE_LOAN_PRODUCT)
  @ApiOperation({
    summary: 'Propose a new loan product',
    description: 'Admin-initiated, workflow-approved.',
  })
  async create(
    @Body() dto: CreateLoanProductDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<WorkflowRequestSummaryDto> {
    const request = await this.loanProductsService.initiateCreation(dto, actor.staffId);
    return WorkflowRequestSummaryDto.fromDocument(request);
  }

  @Patch(':id')
  @RequireCapability(INITIATE_LOAN_PRODUCT)
  @ApiOperation({ summary: 'Propose an update to an existing loan product' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateLoanProductDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<WorkflowRequestSummaryDto> {
    const request = await this.loanProductsService.initiateUpdate(id, dto, actor.staffId);
    return WorkflowRequestSummaryDto.fromDocument(request);
  }

  // Reads: authenticated-only, no capability gate — same reasoning as
  // FeeDefinitionsController. See PHASE_7_NOTES.md.
  @Get()
  @ApiOperation({ summary: 'List loan products', description: 'Optionally filter by status.' })
  async findAll(@Query('status') status?: ProductStatus): Promise<LoanProductResponseDto[]> {
    const products = await this.loanProductsService.findAll({ status });
    return products.map((product) => LoanProductResponseDto.fromDocument(product));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a loan product by id' })
  async findOne(@Param('id') id: string): Promise<LoanProductResponseDto> {
    const product = await this.loanProductsService.findByIdOrThrow(id);
    return LoanProductResponseDto.fromDocument(product);
  }
}
