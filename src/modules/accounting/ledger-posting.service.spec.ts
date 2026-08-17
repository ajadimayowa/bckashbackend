import { Types } from 'mongoose';

import { AccountMappingKey } from '../../common/enums/accounting.enums';
import {
  AccountingTestContext,
  clearJournalEntriesAndWorkflowState,
  createAccountingTestContext,
  teardownAccountingTestContext,
} from './test-support/accounting-test-context';

describe('LedgerPostingService', () => {
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

  describe('the four automated posting types', () => {
    it('postDisbursement debits Loans Receivable and credits Cash/Bank for amountKobo', async () => {
      const memberLoanAccountId = new Types.ObjectId().toString();
      const posted = await ctx.ledgerPostingService.postDisbursement({
        loanId: new Types.ObjectId().toString(),
        memberLoanAccountId,
        amountKobo: 150_000,
        branchId: ctx.branchId,
      });

      const debitAccountId = await ctx.accountingService.resolveMappedAccountId(
        AccountMappingKey.DISBURSEMENT_DEBIT,
      );
      const creditAccountId = await ctx.accountingService.resolveMappedAccountId(
        AccountMappingKey.DISBURSEMENT_CREDIT,
      );
      expect(posted.lines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ accountId: debitAccountId, debitKobo: 150_000 }),
          expect.objectContaining({ accountId: creditAccountId, creditKobo: 150_000 }),
        ]),
      );
      expect(posted.sourceRef).toBe(`LOAN_DISBURSEMENT:${memberLoanAccountId}`);
    });

    it('postFeeCollection debits Cash/Bank and credits Fee Income for amountKobo', async () => {
      const feePaymentId = new Types.ObjectId().toString();
      const posted = await ctx.ledgerPostingService.postFeeCollection({
        feePaymentId,
        amountKobo: 2_500,
        branchId: ctx.branchId,
      });

      const debitAccountId = await ctx.accountingService.resolveMappedAccountId(
        AccountMappingKey.FEE_COLLECTION_DEBIT,
      );
      const creditAccountId = await ctx.accountingService.resolveMappedAccountId(
        AccountMappingKey.FEE_COLLECTION_CREDIT,
      );
      expect(posted.lines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ accountId: debitAccountId, debitKobo: 2_500 }),
          expect.objectContaining({ accountId: creditAccountId, creditKobo: 2_500 }),
        ]),
      );
    });

    it('postRepayment debits Cash/Bank and credits Loans Receivable for amountKobo', async () => {
      const repaymentRecordId = new Types.ObjectId().toString();
      const posted = await ctx.ledgerPostingService.postRepayment({
        repaymentRecordId,
        amountKobo: 40_000,
        branchId: ctx.branchId,
      });

      const debitAccountId = await ctx.accountingService.resolveMappedAccountId(
        AccountMappingKey.REPAYMENT_DEBIT,
      );
      const creditAccountId = await ctx.accountingService.resolveMappedAccountId(
        AccountMappingKey.REPAYMENT_CREDIT,
      );
      expect(posted.lines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ accountId: debitAccountId, debitKobo: 40_000 }),
          expect.objectContaining({ accountId: creditAccountId, creditKobo: 40_000 }),
        ]),
      );
    });

    it('postPenalty debits Penalty Receivable and credits Penalty Income for amountKobo', async () => {
      const sourceEntityId = new Types.ObjectId().toString();
      const posted = await ctx.ledgerPostingService.postPenalty({
        sourceEntityType: 'PENALTY_CHARGE',
        sourceEntityId,
        amountKobo: 1_200,
        branchId: ctx.branchId,
      });

      const debitAccountId = await ctx.accountingService.resolveMappedAccountId(
        AccountMappingKey.PENALTY_DEBIT,
      );
      const creditAccountId = await ctx.accountingService.resolveMappedAccountId(
        AccountMappingKey.PENALTY_CREDIT,
      );
      expect(posted.lines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ accountId: debitAccountId, debitKobo: 1_200 }),
          expect.objectContaining({ accountId: creditAccountId, creditKobo: 1_200 }),
        ]),
      );
    });
  });

  describe('idempotency', () => {
    it('calling postDisbursement twice with identical params creates only one JournalEntry and returns the same one both times', async () => {
      const params = {
        loanId: new Types.ObjectId().toString(),
        memberLoanAccountId: new Types.ObjectId().toString(),
        amountKobo: 75_000,
        branchId: ctx.branchId,
      };

      const first = await ctx.ledgerPostingService.postDisbursement(params);
      const second = await ctx.ledgerPostingService.postDisbursement(params);

      expect(second.id).toBe(first.id);
      const count = await ctx.journalEntryModel
        .countDocuments({ sourceRef: first.sourceRef })
        .exec();
      expect(count).toBe(1);
    });

    it('idempotency holds for postRepayment, postFeeCollection, and postPenalty too', async () => {
      const repaymentParams = {
        repaymentRecordId: new Types.ObjectId().toString(),
        amountKobo: 10_000,
        branchId: ctx.branchId,
      };
      const feeParams = {
        feePaymentId: new Types.ObjectId().toString(),
        amountKobo: 500,
        branchId: ctx.branchId,
      };
      const penaltyParams = {
        sourceEntityType: 'LIQUIDATION_DELAY_CHARGE' as const,
        sourceEntityId: new Types.ObjectId().toString(),
        amountKobo: 800,
        branchId: ctx.branchId,
      };

      const r1 = await ctx.ledgerPostingService.postRepayment(repaymentParams);
      const r2 = await ctx.ledgerPostingService.postRepayment(repaymentParams);
      expect(r2.id).toBe(r1.id);

      const f1 = await ctx.ledgerPostingService.postFeeCollection(feeParams);
      const f2 = await ctx.ledgerPostingService.postFeeCollection(feeParams);
      expect(f2.id).toBe(f1.id);

      const p1 = await ctx.ledgerPostingService.postPenalty(penaltyParams);
      const p2 = await ctx.ledgerPostingService.postPenalty(penaltyParams);
      expect(p2.id).toBe(p1.id);

      expect(await ctx.journalEntryModel.countDocuments({ sourceRef: r1.sourceRef }).exec()).toBe(
        1,
      );
      expect(await ctx.journalEntryModel.countDocuments({ sourceRef: f1.sourceRef }).exec()).toBe(
        1,
      );
      expect(await ctx.journalEntryModel.countDocuments({ sourceRef: p1.sourceRef }).exec()).toBe(
        1,
      );
    });
  });

  describe('concurrency — the unique-index race-condition fallback', () => {
    it('firing two simultaneous postDisbursement calls with the same sourceEntityId creates exactly one JournalEntry', async () => {
      const params = {
        loanId: new Types.ObjectId().toString(),
        memberLoanAccountId: new Types.ObjectId().toString(),
        amountKobo: 60_000,
        branchId: ctx.branchId,
      };

      const [a, b] = await Promise.all([
        ctx.ledgerPostingService.postDisbursement(params),
        ctx.ledgerPostingService.postDisbursement(params),
      ]);

      // Both calls succeeded (neither threw) and agree on the same entry.
      expect(a.id).toBe(b.id);
      const count = await ctx.journalEntryModel.countDocuments({ sourceRef: a.sourceRef }).exec();
      expect(count).toBe(1);
    });

    it('the same race-safety holds for postPenalty', async () => {
      const params = {
        sourceEntityType: 'PENALTY_CHARGE' as const,
        sourceEntityId: new Types.ObjectId().toString(),
        amountKobo: 900,
        branchId: ctx.branchId,
      };

      const results = await Promise.all(
        Array.from({ length: 5 }, () => ctx.ledgerPostingService.postPenalty(params)),
      );
      const uniqueIds = new Set(results.map((r) => r.id));
      expect(uniqueIds.size).toBe(1);

      const count = await ctx.journalEntryModel
        .countDocuments({ sourceRef: results[0]!.sourceRef })
        .exec();
      expect(count).toBe(1);
    });
  });

  describe('postPenalty source-entity distinction', () => {
    it('a PenaltyCharge and a LiquidationDelayCharge with the same underlying id never collide', async () => {
      // Contrived: force the same raw id string for both source types, to
      // prove the distinction lives in sourceRef's prefix, not merely in the
      // (already near-certainly-unique) ObjectId bytes.
      const sharedId = new Types.ObjectId().toString();

      const penaltyCharge = await ctx.ledgerPostingService.postPenalty({
        sourceEntityType: 'PENALTY_CHARGE',
        sourceEntityId: sharedId,
        amountKobo: 1_000,
        branchId: ctx.branchId,
      });
      const delayCharge = await ctx.ledgerPostingService.postPenalty({
        sourceEntityType: 'LIQUIDATION_DELAY_CHARGE',
        sourceEntityId: sharedId,
        amountKobo: 2_000,
        branchId: ctx.branchId,
      });

      expect(penaltyCharge.id).not.toBe(delayCharge.id);
      expect(penaltyCharge.sourceRef).toBe(`PENALTY_CHARGE:${sharedId}`);
      expect(delayCharge.sourceRef).toBe(`LIQUIDATION_DELAY_CHARGE:${sharedId}`);
      // Both still categorized under the same JournalEntry-level sourceEntityType.
      expect(penaltyCharge.sourceEntityType).toBe('PENALTY');
      expect(delayCharge.sourceEntityType).toBe('PENALTY');

      const total = await ctx.journalEntryModel
        .countDocuments({ sourceEntityId: new Types.ObjectId(sharedId) })
        .exec();
      expect(total).toBe(2);
    });
  });
});
