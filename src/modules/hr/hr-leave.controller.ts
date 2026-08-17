import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { ModuleName } from '../../common/enums/identity.enums';
import { RequireModule } from '../../platform/rbac/decorators/require-module.decorator';
import { CurrentStaffContext } from '../../platform/rbac/decorators/current-staff-context.decorator';
import { ModuleAccessGuard } from '../../platform/rbac/guards/module-access.guard';
import { StaffContextGuard } from '../../platform/rbac/guards/staff-context.guard';
import type { ResolvedStaffContext } from '../../platform/rbac/interfaces/staff-context.interface';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { ApplyForLeaveDto } from './dto/apply-for-leave.dto';
import { LeaveApplicationService } from './leave-application.service';
import { LeaveBalanceService, LeaveBalanceSummary } from './leave-balance.service';
import { LeaveApplication } from './schemas/leave-application.schema';

/**
 * `GET my-balance` is self-access, unconditional per the brief — no
 * `@RequireModule`/guard beyond authentication, since it's the caller's own
 * data. Every other route here needs `ModuleName.HR` module access — see
 * PHASE_12_NOTES.md for the judgment call that `apply`/`cancel` are grouped
 * under "leave management" (module-gated) rather than extended the same
 * self-access exemption the brief named only for the two `GET .../mine`-
 * style read endpoints.
 */
@ApiTags('hr')
@ApiBearerAuth('access-token')
@Controller('hr/leave')
export class HrLeaveController {
  constructor(
    private readonly leaveApplicationService: LeaveApplicationService,
    private readonly leaveBalanceService: LeaveBalanceService,
  ) {}

  @Get('my-balance')
  @UseGuards(JwtAuthGuard, StaffContextGuard)
  getMyBalance(
    @CurrentStaffContext() actor: ResolvedStaffContext,
    @Query('year') year?: string,
  ): Promise<LeaveBalanceSummary[]> {
    const resolvedYear = year ? parseInt(year, 10) : new Date().getFullYear();
    return this.leaveBalanceService.getAllSummariesForStaff(actor.staffId, resolvedYear);
  }

  @Post('apply')
  @UseGuards(JwtAuthGuard, StaffContextGuard, ModuleAccessGuard)
  @RequireModule(ModuleName.HR)
  apply(
    @Body() dto: ApplyForLeaveDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<LeaveApplication> {
    return this.leaveApplicationService.applyForLeave(
      actor.staffId,
      dto.leaveTypeId,
      new Date(dto.startDate),
      new Date(dto.endDate),
      dto.reason,
      actor.staffId,
    );
  }

  @Post(':id/cancel')
  @UseGuards(JwtAuthGuard, StaffContextGuard, ModuleAccessGuard)
  @RequireModule(ModuleName.HR)
  cancel(
    @Param('id') id: string,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<LeaveApplication> {
    return this.leaveApplicationService.cancelApplication(id, {
      staffId: actor.staffId,
      capabilities: actor.capabilities,
    });
  }

  @Get('staff/:staffId/balance')
  @UseGuards(JwtAuthGuard, StaffContextGuard, ModuleAccessGuard)
  @RequireModule(ModuleName.HR)
  getStaffBalance(
    @Param('staffId') staffId: string,
    @Query('year') year?: string,
  ): Promise<LeaveBalanceSummary[]> {
    const resolvedYear = year ? parseInt(year, 10) : new Date().getFullYear();
    return this.leaveBalanceService.getAllSummariesForStaff(staffId, resolvedYear);
  }

  @Get('staff/:staffId/applications')
  @UseGuards(JwtAuthGuard, StaffContextGuard, ModuleAccessGuard)
  @RequireModule(ModuleName.HR)
  getStaffApplications(@Param('staffId') staffId: string): Promise<LeaveApplication[]> {
    return this.leaveApplicationService.findForStaff(staffId);
  }
}
