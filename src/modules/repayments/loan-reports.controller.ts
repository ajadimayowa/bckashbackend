import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentStaffContext } from '../../platform/rbac/decorators/current-staff-context.decorator';
import { CapabilityGuard } from '../../platform/rbac/guards/capability.guard';
import { StaffContextGuard } from '../../platform/rbac/guards/staff-context.guard';
import type { ResolvedStaffContext } from '../../platform/rbac/interfaces/staff-context.interface';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { LoanReportsResult, LoanReportsService } from './loan-reports.service';

/**
 * Same "lives here because of module access" reasoning as LoanDetailController/
 * RepaymentsListController — this needs RepaymentRecord/PenaltyCharge
 * (owned by RepaymentsModule) alongside LoansService's own row-scoped
 * listForActor, so it can't live in LoansModule without a cycle.
 *
 * Deliberately its own `loan-reports` resource, NOT mounted under `loans`
 * like LoanDetailController/RepaymentsListController are — a bare `GET
 * /loans/reports` would be a single path segment, the same shape as
 * LoansController's own `GET /loans/:id`, and cross-controller route
 * registration order isn't something to rely on for disambiguating that
 * (unlike `:id/detail`, which never collides — see LoanDetailController's
 * own comment — a different segment count is fine regardless of order; a
 * same-segment-count collision isn't).
 */
@ApiTags('loans')
@ApiBearerAuth('access-token')
@Controller('loan-reports')
@UseGuards(JwtAuthGuard, StaffContextGuard, CapabilityGuard)
export class LoanReportsController {
  constructor(private readonly loanReportsService: LoanReportsService) {}

  @Get()
  @ApiOperation({
    summary: 'Portfolio summary, delinquency, collection trend, and group performance — one payload for the Loan Reports page',
    description:
      'Row-scoped exactly like GET /loans: ADMIN/SUPERADMIN/APPROVER see the whole portfolio ' +
      "(optionally narrowed by branchId), a MANAGER only their own branch's, a MARKETER only loans " +
      'they themselves raised.',
  })
  getReports(
    @Query('branchId') branchId: string | undefined,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<LoanReportsResult> {
    return this.loanReportsService.getReports({ branchId }, actor);
  }
}
