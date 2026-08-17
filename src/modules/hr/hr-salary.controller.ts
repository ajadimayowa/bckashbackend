import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { ModuleName } from '../../common/enums/identity.enums';
import { HR_SALARY_MANAGE_CAPABILITY } from '../../platform/rbac/constants/capabilities';
import { CurrentStaffContext } from '../../platform/rbac/decorators/current-staff-context.decorator';
import { RequireCapability } from '../../platform/rbac/decorators/require-capability.decorator';
import { RequireModule } from '../../platform/rbac/decorators/require-module.decorator';
import { CapabilityGuard } from '../../platform/rbac/guards/capability.guard';
import { ModuleAccessGuard } from '../../platform/rbac/guards/module-access.guard';
import { StaffContextGuard } from '../../platform/rbac/guards/staff-context.guard';
import type { ResolvedStaffContext } from '../../platform/rbac/interfaces/staff-context.interface';
import { WorkflowRequestSummaryDto } from '../../platform/workflow-engine/dto/workflow-request-summary.dto';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { ProposeSalaryChangeDto } from './dto/propose-salary-change.dto';
import { DecryptedSalary, SalaryService } from './salary.service';

/**
 * `GET mine` is self-access, unconditional. Everything else requires BOTH
 * `ModuleName.HR` module access AND `HR_SALARY_MANAGE_CAPABILITY` — see
 * that capability's own doc comment: compensation data is gated more
 * tightly than general leave administration.
 */
@ApiTags('hr')
@ApiBearerAuth('access-token')
@Controller('hr/salary')
export class HrSalaryController {
  constructor(private readonly salaryService: SalaryService) {}

  @Get('mine')
  @UseGuards(JwtAuthGuard, StaffContextGuard)
  getMine(@CurrentStaffContext() actor: ResolvedStaffContext): Promise<DecryptedSalary> {
    return this.salaryService.getCurrentSalary(actor.staffId);
  }

  @Get('staff/:staffId')
  @UseGuards(JwtAuthGuard, StaffContextGuard, ModuleAccessGuard, CapabilityGuard)
  @RequireModule(ModuleName.HR)
  @RequireCapability(HR_SALARY_MANAGE_CAPABILITY)
  getForStaff(@Param('staffId') staffId: string): Promise<DecryptedSalary> {
    return this.salaryService.getCurrentSalary(staffId);
  }

  @Get('staff/:staffId/history')
  @UseGuards(JwtAuthGuard, StaffContextGuard, ModuleAccessGuard, CapabilityGuard)
  @RequireModule(ModuleName.HR)
  @RequireCapability(HR_SALARY_MANAGE_CAPABILITY)
  getHistoryForStaff(@Param('staffId') staffId: string): Promise<DecryptedSalary[]> {
    return this.salaryService.getSalaryHistory(staffId);
  }

  @Post('propose')
  @UseGuards(JwtAuthGuard, StaffContextGuard, ModuleAccessGuard, CapabilityGuard)
  @RequireModule(ModuleName.HR)
  @RequireCapability(HR_SALARY_MANAGE_CAPABILITY)
  async propose(
    @Body() dto: ProposeSalaryChangeDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<WorkflowRequestSummaryDto> {
    const request = await this.salaryService.proposeSalaryChange(
      dto.staffId,
      dto.baseSalaryKobo,
      dto.allowances,
      new Date(dto.effectiveFrom),
      actor.staffId,
      actor.branchId ?? null,
    );
    return WorkflowRequestSummaryDto.fromDocument(request);
  }
}
