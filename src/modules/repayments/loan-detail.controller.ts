import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { RepaymentStatus } from '../../common/enums/repayment.enums';
import { CurrentStaffContext } from '../../platform/rbac/decorators/current-staff-context.decorator';
import { CapabilityGuard } from '../../platform/rbac/guards/capability.guard';
import { StaffContextGuard } from '../../platform/rbac/guards/staff-context.guard';
import type { ResolvedStaffContext } from '../../platform/rbac/interfaces/staff-context.interface';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { LoanDetailResponse, LoanDetailService, RepaymentListItem } from './loan-detail.service';

/**
 * Separate controller (not a method on LoansController) purely because of
 * where module access allows this composition to live — see
 * LoanDetailService's own doc comment. Still mounted under the same `loans`
 * route prefix/Swagger tag; `:id/detail` doesn't collide with
 * LoansController's own `:id` (different segment count).
 */
@ApiTags('loans')
@ApiBearerAuth('access-token')
@Controller('loans')
@UseGuards(JwtAuthGuard, StaffContextGuard, CapabilityGuard)
export class LoanDetailController {
  constructor(private readonly loanDetailService: LoanDetailService) {}

  @Get(':id/detail')
  @ApiOperation({
    summary: 'Get everything the Loan Manager detail view needs for one loan',
    description:
      'Group/product/borrower names, the real approval trail (whatever the product\'s configured ' +
      'chain is — not a fixed stage pipeline), real repayment schedule + records, real penalty ' +
      'charges, and real per-member disbursement verification. Authenticated-only, same reasoning ' +
      'as GET /loans/:id.',
  })
  getDetail(@Param('id') id: string): Promise<LoanDetailResponse> {
    return this.loanDetailService.getLoanDetail(id);
  }
}

/**
 * Same "lives here because of module access" reasoning as LoanDetailController
 * above — row-scoped exactly like GET /loans, just for RepaymentRecord
 * instead. Mounted under `repayments`, alongside (not instead of)
 * RepaymentsController's own narrower routes (no path collision: that
 * controller has no bare `GET /repayments`).
 */
@ApiTags('repayments')
@ApiBearerAuth('access-token')
@Controller('repayments')
@UseGuards(JwtAuthGuard, StaffContextGuard, CapabilityGuard)
export class RepaymentsListController {
  constructor(private readonly loanDetailService: LoanDetailService) {}

  @Get()
  @ApiOperation({
    summary: 'List repayments',
    description:
      'Row-scoped like GET /loans: ADMIN/SUPERADMIN/APPROVER see every repayment (optionally ' +
      "narrowed by branchId/loanId/status), a MANAGER only their own branch's, a MARKETER only " +
      'ones they themselves recorded.',
  })
  listForActor(
    @Query('branchId') branchId: string | undefined,
    @Query('loanId') loanId: string | undefined,
    @Query('status') status: RepaymentStatus | undefined,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<RepaymentListItem[]> {
    return this.loanDetailService.listRepaymentsForActor({ branchId, loanId, status }, actor);
  }
}
