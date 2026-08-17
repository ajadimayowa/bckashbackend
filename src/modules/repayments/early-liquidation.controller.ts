import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { WorkflowEntityType } from '../../common/enums/workflow.enums';
import { initiateCapability } from '../../platform/rbac/constants/capabilities';
import { CurrentStaffContext } from '../../platform/rbac/decorators/current-staff-context.decorator';
import { RequireCapability } from '../../platform/rbac/decorators/require-capability.decorator';
import { CapabilityGuard } from '../../platform/rbac/guards/capability.guard';
import { StaffContextGuard } from '../../platform/rbac/guards/staff-context.guard';
import type { ResolvedStaffContext } from '../../platform/rbac/interfaces/staff-context.interface';
import { WorkflowRequestSummaryDto } from '../../platform/workflow-engine/dto/workflow-request-summary.dto';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { InitiateEarlyLiquidationDto } from './dto/initiate-early-liquidation.dto';
import { LinkRepaymentToLiquidationDto } from './dto/link-repayment-to-liquidation.dto';
import { EarlyLiquidationService } from './early-liquidation.service';
import { EarlyLiquidationRequest } from './schemas/early-liquidation-request.schema';
import { RepaymentRecord } from './schemas/repayment-record.schema';

const INITIATE_EARLY_LIQUIDATION = initiateCapability(WorkflowEntityType.EARLY_LIQUIDATION);
const INITIATE_REPAYMENT = initiateCapability(WorkflowEntityType.REPAYMENT_RECORD);

@ApiTags('early-liquidations')
@ApiBearerAuth('access-token')
@Controller('early-liquidations')
@UseGuards(JwtAuthGuard, StaffContextGuard, CapabilityGuard)
export class EarlyLiquidationController {
  constructor(private readonly earlyLiquidationService: EarlyLiquidationService) {}

  @Post()
  @RequireCapability(INITIATE_EARLY_LIQUIDATION)
  async initiate(
    @Body() dto: InitiateEarlyLiquidationDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<WorkflowRequestSummaryDto> {
    const { workflowRequest } = await this.earlyLiquidationService.initiateEarlyLiquidation(
      dto.memberLoanAccountId,
      actor.staffId,
    );
    return WorkflowRequestSummaryDto.fromDocument(workflowRequest);
  }

  // Gated the same as recording a repayment — this is the same staff action
  // ("I'm recording the payment that settles this liquidation"), not a
  // separate approval-level decision. See PHASE_9_NOTES.md.
  @Post(':repaymentId/link')
  @RequireCapability(INITIATE_REPAYMENT)
  linkRepayment(
    @Param('repaymentId') repaymentId: string,
    @Body() dto: LinkRepaymentToLiquidationDto,
  ): Promise<RepaymentRecord> {
    return this.earlyLiquidationService.linkRepaymentToLiquidation(
      repaymentId,
      dto.liquidationRequestId,
    );
  }

  @Get(':id')
  findOne(@Param('id') id: string): Promise<EarlyLiquidationRequest> {
    return this.earlyLiquidationService.findByIdOrThrow(id);
  }
}
