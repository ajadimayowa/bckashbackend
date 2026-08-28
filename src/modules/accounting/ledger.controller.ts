import { Controller, Get, Param, Post, Body, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ModuleName } from '../../common/enums/identity.enums';
import { CurrentStaffContext } from '../../platform/rbac/decorators/current-staff-context.decorator';
import { RequireModule } from '../../platform/rbac/decorators/require-module.decorator';
import { ModuleAccessGuard } from '../../platform/rbac/guards/module-access.guard';
import { StaffContextGuard } from '../../platform/rbac/guards/staff-context.guard';
import type { ResolvedStaffContext } from '../../platform/rbac/interfaces/staff-context.interface';
import { WorkflowRequestSummaryDto } from '../../platform/workflow-engine/dto/workflow-request-summary.dto';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { AccountingService, LedgerEntriesPage, TrialBalance } from './accounting.service';
import { ProposeManualJournalEntryDto } from './dto/propose-manual-journal-entry.dto';
import { ManualJournalEntryService } from './manual-journal-entry.service';

/**
 * "Basic accounting operations accessible to all users" — every route here
 * requires only `ModuleName.ACCOUNTING` module access (`@RequireModule`),
 * no specific capability. Reading the ledger and *proposing* a manual entry
 * are both open to any accounting-module staff member; the entry itself
 * isn't posted until a separate Admin/SuperAdmin approves it through the
 * generic workflow-approval path (no HTTP endpoint exposes `act()` directly
 * in this codebase yet — consistent with every other phase's approval flow,
 * not a gap specific to this one). See PHASE_10_NOTES.md.
 */
@ApiTags('accounting')
@ApiBearerAuth('access-token')
@Controller('accounting/ledger')
@UseGuards(JwtAuthGuard, StaffContextGuard, ModuleAccessGuard)
@RequireModule(ModuleName.ACCOUNTING)
export class LedgerController {
  constructor(
    private readonly accountingService: AccountingService,
    private readonly manualJournalEntryService: ManualJournalEntryService,
  ) {}

  @Get('accounts/:accountId/balance')
  @ApiOperation({
    summary: 'Get an account balance',
    description:
      'Signed per normal-balance convention (ASSET/EXPENSE debit-normal, LIABILITY/EQUITY/INCOME credit-normal). Optionally as-of a date.',
  })
  async getAccountBalance(
    @Param('accountId') accountId: string,
    @Query('asOfDate') asOfDate?: string,
  ): Promise<{ balanceKobo: number }> {
    const balanceKobo = await this.accountingService.getAccountBalance(
      accountId,
      asOfDate ? new Date(asOfDate) : undefined,
    );
    return { balanceKobo };
  }

  @Get('trial-balance')
  @ApiOperation({
    summary: 'Get the trial balance',
    description:
      'Every account with a balance, confirming total debits equal total credits system-wide.',
  })
  getTrialBalance(
    @Query('asOfDate') asOfDate?: string,
    @Query('branchId') branchId?: string,
  ): Promise<TrialBalance> {
    return this.accountingService.getTrialBalance(
      asOfDate ? new Date(asOfDate) : undefined,
      branchId,
    );
  }

  @Get('accounts/:accountId/entries')
  @ApiOperation({
    summary: "Get an account's ledger entries",
    description: 'Paginated, for reconciliation/audit.',
  })
  getLedgerEntries(
    @Param('accountId') accountId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('branchId') branchId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<LedgerEntriesPage> {
    return this.accountingService.getLedgerEntries(accountId, {
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      branchId,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Post('manual-entries')
  @ApiOperation({
    summary: 'Propose a manual journal entry',
    description:
      'Balance-validated before initiation; not posted until a separate Admin/SuperAdmin approves it.',
  })
  async proposeManualEntry(
    @Body() dto: ProposeManualJournalEntryDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<WorkflowRequestSummaryDto> {
    const request = await this.manualJournalEntryService.proposeEntry(dto, actor.staffId);
    return WorkflowRequestSummaryDto.fromDocument(request);
  }
}
