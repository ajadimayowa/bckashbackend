import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';

import {
  BRANCH_FUND_CAPABILITY,
  BRANCH_VERIFY_FUNDING_CAPABILITY,
} from '../../platform/rbac/constants/capabilities';
import { CurrentStaffContext } from '../../platform/rbac/decorators/current-staff-context.decorator';
import { RequireCapability } from '../../platform/rbac/decorators/require-capability.decorator';
import { CapabilityGuard } from '../../platform/rbac/guards/capability.guard';
import { StaffContextGuard } from '../../platform/rbac/guards/staff-context.guard';
import type { ResolvedStaffContext } from '../../platform/rbac/interfaces/staff-context.interface';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { BranchFundingService } from './branch-funding.service';
import { RecordBranchFundingDto } from './dto/record-branch-funding.dto';
import { RejectBranchFundingDto } from './dto/reject-branch-funding.dto';
import { BranchFunding } from './schemas/branch-funding.schema';

@Controller('branch-funding')
@UseGuards(JwtAuthGuard, StaffContextGuard, CapabilityGuard)
export class BranchFundingController {
  constructor(private readonly branchFundingService: BranchFundingService) {}

  @Post()
  @RequireCapability(BRANCH_FUND_CAPABILITY)
  record(
    @Body() dto: RecordBranchFundingDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<BranchFunding> {
    return this.branchFundingService.recordFunding(dto, actor.staffId);
  }

  @Get()
  @RequireCapability(BRANCH_FUND_CAPABILITY)
  findAll(@Query('branchId') branchId?: string): Promise<BranchFunding[]> {
    return this.branchFundingService.findAll(branchId);
  }

  @Get(':id')
  @RequireCapability(BRANCH_FUND_CAPABILITY)
  findOne(@Param('id') id: string): Promise<BranchFunding> {
    return this.branchFundingService.findById(id);
  }

  @Post(':id/verify')
  @RequireCapability(BRANCH_VERIFY_FUNDING_CAPABILITY)
  verify(
    @Param('id') id: string,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<BranchFunding> {
    return this.branchFundingService.verifyFunding(id, actor.staffId);
  }

  @Post(':id/reject')
  @RequireCapability(BRANCH_VERIFY_FUNDING_CAPABILITY)
  reject(
    @Param('id') id: string,
    @Body() dto: RejectBranchFundingDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<BranchFunding> {
    return this.branchFundingService.rejectFunding(id, actor.staffId, dto.reason);
  }
}
