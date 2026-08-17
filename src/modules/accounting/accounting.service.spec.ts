import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';

import {
  AccountMappingKey,
  AccountType,
  JournalSourceEvent,
} from '../../common/enums/accounting.enums';
import {
  AccountingTestContext,
  clearJournalEntriesAndWorkflowState,
  createAccountingTestContext,
  teardownAccountingTestContext,
} from './test-support/accounting-test-context';

describe('AccountingService', () => {
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

  describe('chart of accounts seeding', () => {
    it('seeds the default chart of accounts at module init', async () => {
      const accounts = await ctx.accountingService.findAllAccounts();
      const codes = accounts.map((a) => a.code).sort();
      expect(codes).toEqual(['1010', '1020', '1030', '4010', '4020', '4030']);
    });

    it('resolves every default AccountMapping key to a real, existing Account document', async () => {
      for (const key of Object.values(AccountMappingKey)) {
        const accountId = await ctx.accountingService.resolveMappedAccountId(key);
        const account = await ctx.accountingService.findAccountByIdOrThrow(accountId);
        expect(account).not.toBeNull();
      }
    });

    it('maps DISBURSEMENT_DEBIT to Loans Receivable (1020) and DISBURSEMENT_CREDIT to Cash/Bank (1010)', async () => {
      const debitAccountId = await ctx.accountingService.resolveMappedAccountId(
        AccountMappingKey.DISBURSEMENT_DEBIT,
      );
      const creditAccountId = await ctx.accountingService.resolveMappedAccountId(
        AccountMappingKey.DISBURSEMENT_CREDIT,
      );
      const debitAccount = await ctx.accountingService.findAccountByIdOrThrow(debitAccountId);
      const creditAccount = await ctx.accountingService.findAccountByIdOrThrow(creditAccountId);
      expect(debitAccount.code).toBe('1020');
      expect(creditAccount.code).toBe('1010');
    });
  });

  describe('chart of accounts CRUD', () => {
    it('enforces a unique account code', async () => {
      await ctx.accountingService.createAccount({
        code: `TEST-${Date.now()}`,
        name: 'Test Account',
        type: AccountType.ASSET,
      });
      const duplicateCode = (await ctx.accountModel.findOne({}).exec())!.code;

      await expect(
        ctx.accountingService.createAccount({
          code: '1010', // already seeded
          name: 'Duplicate Cash Account',
          type: AccountType.ASSET,
        }),
      ).rejects.toThrow(BadRequestException);

      expect(duplicateCode).toBeDefined();
    });

    it('creates and updates an account', async () => {
      const created = await ctx.accountingService.createAccount({
        code: `CUSTOM-${Date.now()}`,
        name: 'Custom Account',
        type: AccountType.LIABILITY,
      });
      expect(created.active).toBe(true);

      const updated = await ctx.accountingService.updateAccount(created._id.toString(), {
        name: 'Renamed Account',
        active: false,
      });
      expect(updated.name).toBe('Renamed Account');
      expect(updated.active).toBe(false);
    });
  });

  describe('getAccountBalance — signed per normal-balance convention', () => {
    async function postDirectEntry(
      accountIdDebited: string,
      accountIdCredited: string,
      amountKobo: number,
      ref: string,
    ) {
      await ctx.journalEntryModel.create({
        sourceEntityType: JournalSourceEvent.MANUAL_ADJUSTMENT,
        sourceEntityId: new Types.ObjectId(),
        sourceRef: ref,
        branchId: new Types.ObjectId(ctx.branchId),
        date: new Date(),
        lines: [
          {
            accountId: new Types.ObjectId(accountIdDebited),
            debitKobo: amountKobo,
            creditKobo: null,
          },
          {
            accountId: new Types.ObjectId(accountIdCredited),
            debitKobo: null,
            creditKobo: amountKobo,
          },
        ],
        createdBy: null,
        postedBySystem: true,
        postedAt: new Date(),
      });
    }

    it('an ASSET account (Loans Receivable) shows a positive balance when debited more than credited', async () => {
      const cashId = await ctx.accountingService.resolveMappedAccountId(
        AccountMappingKey.DISBURSEMENT_CREDIT,
      );
      const receivableId = await ctx.accountingService.resolveMappedAccountId(
        AccountMappingKey.DISBURSEMENT_DEBIT,
      );
      await postDirectEntry(receivableId, cashId, 100_000, `test-asset-${Date.now()}`);

      const balance = await ctx.accountingService.getAccountBalance(receivableId);
      expect(balance).toBe(100_000);
    });

    it('an INCOME account (Fee Income) shows a positive balance when credited more than debited', async () => {
      const cashId = await ctx.accountingService.resolveMappedAccountId(
        AccountMappingKey.FEE_COLLECTION_DEBIT,
      );
      const feeIncomeId = await ctx.accountingService.resolveMappedAccountId(
        AccountMappingKey.FEE_COLLECTION_CREDIT,
      );
      await postDirectEntry(cashId, feeIncomeId, 5_000, `test-income-${Date.now()}`);

      const balance = await ctx.accountingService.getAccountBalance(feeIncomeId);
      // Credit-normal account, credited more than debited -> positive, not negative.
      expect(balance).toBe(5_000);
    });
  });

  describe('getTrialBalance', () => {
    it('sums to zero net (total debits = total credits) across a mixed set of entries', async () => {
      const cashId = await ctx.accountingService.resolveMappedAccountId(
        AccountMappingKey.DISBURSEMENT_CREDIT,
      );
      const receivableId = await ctx.accountingService.resolveMappedAccountId(
        AccountMappingKey.DISBURSEMENT_DEBIT,
      );
      const feeIncomeId = await ctx.accountingService.resolveMappedAccountId(
        AccountMappingKey.FEE_COLLECTION_CREDIT,
      );

      await ctx.ledgerPostingService.postDisbursement({
        loanId: new Types.ObjectId().toString(),
        memberLoanAccountId: new Types.ObjectId().toString(),
        amountKobo: 200_000,
        branchId: ctx.branchId,
      });
      await ctx.ledgerPostingService.postFeeCollection({
        feePaymentId: new Types.ObjectId().toString(),
        amountKobo: 3_000,
        branchId: ctx.branchId,
      });

      const trialBalance = await ctx.accountingService.getTrialBalance();
      expect(trialBalance.balanced).toBe(true);
      expect(trialBalance.totalDebitKobo).toBe(trialBalance.totalCreditKobo);
      expect(trialBalance.totalDebitKobo).toBe(203_000);

      const receivableRow = trialBalance.accounts.find((a) => a.accountId === receivableId);
      const cashRow = trialBalance.accounts.find((a) => a.accountId === cashId);
      const feeIncomeRow = trialBalance.accounts.find((a) => a.accountId === feeIncomeId);
      expect(receivableRow?.balanceKobo).toBe(200_000);
      // Cash: debited 3,000 (fee collection), credited 200,000 (disbursement)
      // — an ASSET's normal-debit balance is debit-minus-credit, so this
      // reads as a large negative (the branch's cash fund is a separate
      // concept — BranchFundBalance — this "Cash/Bank" ledger account is
      // purely a double-entry bookkeeping account, not the same balance).
      expect(cashRow?.balanceKobo).toBe(3_000 - 200_000);
      expect(feeIncomeRow?.balanceKobo).toBe(3_000);
    });
  });
});
