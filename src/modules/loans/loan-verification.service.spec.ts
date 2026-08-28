import { DisbursementChannel } from '../../common/enums/loan.enums';
import {
  clearAllExceptChainConfigs,
  createRepaymentsTestContext,
  raiseApproveVerifyAndDisburseLoan,
  resetBranchFixture,
  RepaymentsTestContext,
  teardownRepaymentsTestContext,
} from '../repayments/test-support/repayments-test-context';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Weekly-repayment-cadence coverage for LoanVerificationService.disburse/
 * normalizeSchedule/confirmChequeHandover — added alongside
 * LoanProduct.repaymentPeriodDays. Reuses the same shared test scaffolding
 * (createRepaymentsTestContext et al.) as the Phase 9 repayments spec files,
 * since a disbursed loan is exactly what those already build — see that
 * file's own doc comment.
 */
describe('LoanVerificationService — weekly repayment schedule', () => {
  let ctx: RepaymentsTestContext;

  beforeAll(async () => {
    ctx = await createRepaymentsTestContext();
  }, 60_000);

  beforeEach(async () => {
    await resetBranchFixture(ctx);
  });

  afterEach(async () => {
    await clearAllExceptChainConfigs(ctx);
  });

  afterAll(async () => {
    await teardownRepaymentsTestContext(ctx);
  });

  it('produces ceil(tenureDays / repaymentPeriodDays) installments, 7 days apart by default, with the final one clamped to exactly tenureDays after disbursement', async () => {
    const { memberLoanAccountIds, loanId } = await raiseApproveVerifyAndDisburseLoan(ctx, {
      productOverrides: { tenureOptions: [30] }, // repaymentPeriodDays defaults to 7 -> ceil(30/7) = 5
    });
    const account = await ctx.memberLoanAccountModel.findById(memberLoanAccountIds[0]!).exec();
    const loan = await ctx.loanModel.findById(loanId).exec();
    const disbursedAt = loan!.disbursedAt!.getTime();

    expect(account!.schedule).toHaveLength(5);
    expect(account!.schedule[0]!.dueDate.getTime()).toBe(disbursedAt + 7 * ONE_DAY_MS);
    expect(account!.schedule[1]!.dueDate.getTime()).toBe(disbursedAt + 14 * ONE_DAY_MS);
    expect(account!.schedule[2]!.dueDate.getTime()).toBe(disbursedAt + 21 * ONE_DAY_MS);
    expect(account!.schedule[3]!.dueDate.getTime()).toBe(disbursedAt + 28 * ONE_DAY_MS);
    // 5th installment would naively fall at +35 days (5*7) — clamped to the
    // actual 30-day tenure instead, so the loan's last repayment date never
    // overshoots "the loan tenure is completed".
    expect(account!.schedule[4]!.dueDate.getTime()).toBe(disbursedAt + 30 * ONE_DAY_MS);
  });

  it('honors a custom (non-default) repaymentPeriodDays on the product', async () => {
    const { memberLoanAccountIds, loanId } = await raiseApproveVerifyAndDisburseLoan(ctx, {
      productOverrides: { tenureOptions: [20], repaymentPeriodDays: 5 },
    });
    const account = await ctx.memberLoanAccountModel.findById(memberLoanAccountIds[0]!).exec();
    const loan = await ctx.loanModel.findById(loanId).exec();
    const disbursedAt = loan!.disbursedAt!.getTime();

    expect(account!.schedule).toHaveLength(4); // ceil(20/5) = 4, an exact multiple
    expect(account!.schedule[3]!.dueDate.getTime()).toBe(disbursedAt + 20 * ONE_DAY_MS);
  });

  it('a single-installment tenure (shorter than one repayment period) still produces exactly one installment, due at tenureDays', async () => {
    const { memberLoanAccountIds, loanId } = await raiseApproveVerifyAndDisburseLoan(ctx, {
      productOverrides: { tenureOptions: [14], repaymentPeriodDays: 30 },
    });
    const account = await ctx.memberLoanAccountModel.findById(memberLoanAccountIds[0]!).exec();
    const loan = await ctx.loanModel.findById(loanId).exec();
    const disbursedAt = loan!.disbursedAt!.getTime();

    expect(account!.schedule).toHaveLength(1);
    expect(account!.schedule[0]!.dueDate.getTime()).toBe(disbursedAt + 14 * ONE_DAY_MS);
  });

  describe('CHEQUE_PICKUP re-anchoring', () => {
    it('anchors due dates to the disbursement date until handover, then re-anchors every entry to the real chequeHandedOverAt date once confirmed', async () => {
      const { memberLoanAccountIds } = await raiseApproveVerifyAndDisburseLoan(ctx, {
        disbursementChannel: DisbursementChannel.CHEQUE_PICKUP,
        productOverrides: { tenureOptions: [14] }, // installmentCount = 2, both exactly 7 days apart
      });
      const accountId = memberLoanAccountIds[0]!;

      const beforeHandover = await ctx.memberLoanAccountModel.findById(accountId).exec();
      expect(beforeHandover!.chequeHandedOverAt).toBeNull();
      const provisionalFirstDueDate = beforeHandover!.schedule[0]!.dueDate.getTime();

      const updated = await ctx.loanVerificationService.confirmChequeHandover(
        accountId,
        ctx.INITIATOR_ID,
      );
      expect(updated.chequeHandedOverAt).not.toBeNull();
      const handoverAt = updated.chequeHandedOverAt!.getTime();

      // Re-anchored — no longer the provisional, disbursement-anchored date
      // (unless handover happened to land on the exact same instant, which
      // it never does here since raiseApproveVerifyAndDisburseLoan disburses
      // strictly before this later, separate confirmChequeHandover call).
      expect(updated.schedule[0]!.dueDate.getTime()).not.toBe(provisionalFirstDueDate);
      expect(updated.schedule[0]!.dueDate.getTime()).toBe(handoverAt + 7 * ONE_DAY_MS);
      expect(updated.schedule[1]!.dueDate.getTime()).toBe(handoverAt + 14 * ONE_DAY_MS);

      // Persisted, not just returned in-memory.
      const persisted = await ctx.memberLoanAccountModel.findById(accountId).exec();
      expect(persisted!.schedule[0]!.dueDate.getTime()).toBe(handoverAt + 7 * ONE_DAY_MS);
      expect(persisted!.schedule[1]!.dueDate.getTime()).toBe(handoverAt + 14 * ONE_DAY_MS);
    });

    it('rejects a second handover confirmation on the same account', async () => {
      const { memberLoanAccountIds } = await raiseApproveVerifyAndDisburseLoan(ctx, {
        disbursementChannel: DisbursementChannel.CHEQUE_PICKUP,
      });
      const accountId = memberLoanAccountIds[0]!;
      await ctx.loanVerificationService.confirmChequeHandover(accountId, ctx.INITIATOR_ID);

      await expect(
        ctx.loanVerificationService.confirmChequeHandover(accountId, ctx.INITIATOR_ID),
      ).rejects.toThrow(/already handed over/);
    });

    it('rejects handover confirmation for a TRANSFER account', async () => {
      const { memberLoanAccountIds } = await raiseApproveVerifyAndDisburseLoan(ctx, {
        disbursementChannel: DisbursementChannel.TRANSFER,
      });
      const accountId = memberLoanAccountIds[0]!;

      await expect(
        ctx.loanVerificationService.confirmChequeHandover(accountId, ctx.INITIATOR_ID),
      ).rejects.toThrow(/not a CHEQUE_PICKUP disbursement/);
    });
  });
});
