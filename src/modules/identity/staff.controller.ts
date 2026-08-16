import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';

import { WorkflowEntityType } from '../../common/enums/workflow.enums';
import { WorkflowRequestSummaryDto } from '../../platform/workflow-engine/dto/workflow-request-summary.dto';
import {
  ORG_MANAGE_CAPABILITY,
  STAFF_CREATE_DIRECT_CAPABILITY,
  STAFF_DISABLE_CAPABILITY,
  initiateCapability,
} from '../../platform/rbac/constants/capabilities';
import { CurrentStaffContext } from '../../platform/rbac/decorators/current-staff-context.decorator';
import { RequireCapability } from '../../platform/rbac/decorators/require-capability.decorator';
import { CapabilityGuard } from '../../platform/rbac/guards/capability.guard';
import { StaffContextGuard } from '../../platform/rbac/guards/staff-context.guard';
import type { ResolvedStaffContext } from '../../platform/rbac/interfaces/staff-context.interface';
import { CreateStaffDirectDto } from './dto/create-staff-direct.dto';
import { DisableStaffDto } from './dto/disable-staff.dto';
import { InitiateStaffOnboardingDto } from './dto/initiate-staff-onboarding.dto';
import { StaffResponseDto } from './dto/staff-response.dto';
import { VerifyStaffBvnDto } from './dto/verify-staff-bvn.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { StaffService } from './staff.service';

@Controller('staff')
@UseGuards(JwtAuthGuard, StaffContextGuard, CapabilityGuard)
export class StaffController {
  constructor(private readonly staffService: StaffService) {}

  @Post('onboard')
  @RequireCapability(initiateCapability(WorkflowEntityType.STAFF))
  async onboard(
    @Body() dto: InitiateStaffOnboardingDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<WorkflowRequestSummaryDto> {
    const request = await this.staffService.initiateOnboarding(dto, actor.staffId);
    return WorkflowRequestSummaryDto.fromDocument(request);
  }

  @Post('direct')
  @RequireCapability(STAFF_CREATE_DIRECT_CAPABILITY)
  async createDirect(
    @Body() dto: CreateStaffDirectDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<StaffResponseDto> {
    const staff = await this.staffService.createDirect(dto, actor.staffId);
    return StaffResponseDto.fromDocument(staff);
  }

  @Get()
  @RequireCapability(ORG_MANAGE_CAPABILITY)
  async findAll(@Query('branchId') branchId?: string): Promise<StaffResponseDto[]> {
    const staff = await this.staffService.findAll(branchId ? { branchId } : {});
    return staff.map((s) => StaffResponseDto.fromDocument(s));
  }

  // Must precede `@Get(':id')` — otherwise "bvn" would be matched as an :id.
  @Get('bvn/unverified')
  @RequireCapability(ORG_MANAGE_CAPABILITY)
  async findWithUnverifiedBvn(): Promise<StaffResponseDto[]> {
    const staff = await this.staffService.findStaffWithUnverifiedBvn();
    return staff.map((s) => StaffResponseDto.fromDocument(s));
  }

  @Get(':id')
  @RequireCapability(ORG_MANAGE_CAPABILITY)
  async findOne(@Param('id') id: string): Promise<StaffResponseDto> {
    const staff = await this.staffService.findById(id);
    return StaffResponseDto.fromDocument(staff);
  }

  @Post(':id/verify-bvn')
  @RequireCapability(STAFF_DISABLE_CAPABILITY)
  async verifyBvn(
    @Param('id') id: string,
    @Body() dto: VerifyStaffBvnDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<StaffResponseDto> {
    const staff = await this.staffService.verifyBvn(id, dto.bvn, actor.staffId);
    return StaffResponseDto.fromDocument(staff);
  }

  @Post(':id/disable')
  @RequireCapability(STAFF_DISABLE_CAPABILITY)
  async disable(
    @Param('id') id: string,
    @Body() dto: DisableStaffDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<StaffResponseDto> {
    const staff = await this.staffService.disable(id, actor.staffId, dto.reason);
    return StaffResponseDto.fromDocument(staff);
  }

  @Post(':id/enable')
  @RequireCapability(STAFF_DISABLE_CAPABILITY)
  async enable(
    @Param('id') id: string,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<StaffResponseDto> {
    const staff = await this.staffService.enable(id, actor.staffId);
    return StaffResponseDto.fromDocument(staff);
  }
}
