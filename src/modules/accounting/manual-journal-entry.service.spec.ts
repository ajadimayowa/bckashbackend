import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';

import { AccountMappingKey } from '../../common/enums/accounting.enums';
import {
  AccountingTestContext,
  approveManualEntryActor,
  approveWorkflowRequest,
  clearJournalEntriesAndWorkflowState,
  createAccountingTestContext,
  teardownAccountingTestContext,
} from './test-support/accounting-test-context';

describe('ManualJournalEntryService', () => {
  let ctx: AccountingTestContext;

  beforeAll(async () => {
    ctx = await createAccountingTestContext();
  }, 60_000);

  afterEach(async () => {
    await clearJournalEntriesAndWorkflowState(ctx);
  });

  afterAll(async () => {
    await teardownAccountingTestContext(ctx);
  });

  async function balancedLines(): Promise<
    { accountId: string; debitKobo?: number; creditKobo?: number }[]
  > {
    const debitAccountId = await ctx.accountingService.resolveMappedAccountId(
      AccountMappingKey.DISBURSEMENT_DEBIT,
    );
    const creditAccountId = await ctx.accountingService.resolveMappedAccountId(
      AccountMappingKey.DISBURSEMENT_CREDIT,
    );
    return [
      { accountId: debitAccountId, debitKobo: 10_000 },
      { accountId: creditAccountId, creditKobo: 10_000 },
    ];
  }

  it('is not persisted until workflow.approved', async () => {
    const lines = await balancedLines();
    const request = await ctx.manualJournalEntryService.proposeEntry(
      {
        branchId: ctx.branchId,
        date: new Date().toISOString(),
        lines,
        description: 'Test manual entry',
      },
      ctx.MAKER_ID,
    );

    const before = await ctx.journalEntryModel
      .findOne({ sourceRef: `MANUAL:${request._id.toString()}` })
      .exec();
    expect(before).toBeNull();

    await approveWorkflowRequest(ctx, request._id.toString(), approveManualEntryActor(ctx));

    const after = await ctx.journalEntryModel
      .findOne({ sourceRef: `MANUAL:${request._id.toString()}` })
      .exec();
    expect(after).not.toBeNull();
    expect(after!.postedBySystem).toBe(false);
    expect(after!.createdBy?.toString()).toBe(ctx.MAKER_ID);
  });

  it('validates balance BEFORE initiating the workflow — rejects an unbalanced proposal immediately, creating no WorkflowRequest', async () => {
    const debitAccountId = await ctx.accountingService.resolveMappedAccountId(
      AccountMappingKey.DISBURSEMENT_DEBIT,
    );
    const creditAccountId = await ctx.accountingService.resolveMappedAccountId(
      AccountMappingKey.DISBURSEMENT_CREDIT,
    );
    const unbalancedLines = [
      { accountId: debitAccountId, debitKobo: 10_000 },
      { accountId: creditAccountId, creditKobo: 9_000 },
    ];

    const before = await ctx.workflowRequestModel.countDocuments({}).exec();

    await expect(
      ctx.manualJournalEntryService.proposeEntry(
        { branchId: ctx.branchId, date: new Date().toISOString(), lines: unbalancedLines },
        ctx.ADMIN_ID,
      ),
    ).rejects.toThrow(BadRequestException);

    const after = await ctx.workflowRequestModel.countDocuments({}).exec();
    expect(after).toBe(before);
  });

  it('rejects a proposal referencing a non-existent account', async () => {
    await expect(
      ctx.manualJournalEntryService.proposeEntry(
        {
          branchId: ctx.branchId,
          date: new Date().toISOString(),
          lines: [
            { accountId: new Types.ObjectId().toString(), debitKobo: 1_000 },
            { accountId: new Types.ObjectId().toString(), creditKobo: 1_000 },
          ],
        },
        ctx.ADMIN_ID,
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('registers a single-step (approve-only) chain for MANUAL_JOURNAL_ENTRY', async () => {
    const lines = await balancedLines();
    const request = await ctx.manualJournalEntryService.proposeEntry(
      { branchId: ctx.branchId, date: new Date().toISOString(), lines },
      ctx.ADMIN_ID,
    );
    expect(request.steps).toHaveLength(1);
  });
});
