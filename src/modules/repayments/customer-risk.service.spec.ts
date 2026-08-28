import { Types } from 'mongoose';

import { FeeCalcType, PenaltyFrequency } from '../../common/enums/loan-product.enums';
import { DisbursementChannel } from '../../common/enums/loan.enums';
import {
  clearAllExceptChainConfigs,
  createRepaymentsTestContext,
  raiseApproveVerifyAndDisburseLoan,
  recordAndApproveRepayment,
  resetBranchFixture,
  RepaymentsTestContext,
  teardownRepaymentsTestContext,
} from './test-support/repayments-test-context';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const FIXED_DUE_DATE = new Date('2024-01-01T00:00:00.000Z');

function referenceDateAt(daysAfterDue: number): Date {
  return new Date(FIXED_DUE_DATE.getTime() + daysAfterDue * ONE_DAY_MS);
}

describe('CustomerRiskService', () => {
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

  async function setFirstInstallmentDueDate(accountId: string, dueDate: Date): Promise<void> {
    await ctx.memberLoanAccountModel
      .updateOne(
        { _id: accountId },
        { $set: { 'schedule.$[elem].dueDate': dueDate } },
        { arrayFilters: [{ 'elem.installmentNumber': 1 }] },
      )
      .exec();
  }

  /**
   * `memberLoanAccountIds[i]`/`customerIds[i]` are NOT guaranteed to line up
   * index-for-index (accounts come back from an unordered `find({loanId})`,
   * customerIds from group-creation order) — always resolve the actual
   * customerId that owns a given account directly, rather than assuming
   * they're the same position in both arrays.
   */
  async function customerIdForAccount(accountId: string): Promise<string> {
    const account = await ctx.memberLoanAccountModel.findById(accountId).exec();
    return account!.customerId.toString();
  }

  it('flags NONE when nothing is overdue', async () => {
    const { customerIds } = await raiseApproveVerifyAndDisburseLoan(ctx);
    const risk = await ctx.customerRiskService.getRepaymentRisk(customerIds[0]!);
    expect(risk).toEqual({
      flag: 'NONE',
      daysPastGrace: null,
      memberLoanAccountId: null,
      message: null,
    });
  });

  it('flags AMBER once past grace but still within the first repaymentPeriodDays cycle', async () => {
    const { memberLoanAccountIds } = await raiseApproveVerifyAndDisburseLoan(ctx, {
      productOverrides: {
        penaltyRule: {
          calcType: FeeCalcType.FIXED,
          value: 1_000,
          gracePeriodDays: 0,
          frequency: PenaltyFrequency.ONE_TIME,
        },
      },
    });
    await setFirstInstallmentDueDate(memberLoanAccountIds[0]!, FIXED_DUE_DATE);
    const customerId = await customerIdForAccount(memberLoanAccountIds[0]!);

    const risk = await ctx.customerRiskService.getRepaymentRisk(
      customerId,
      referenceDateAt(3), // 3 days past grace(0), <= repaymentPeriodDays(7)
    );
    expect(risk.flag).toBe('AMBER');
    expect(risk.daysPastGrace).toBe(3);
    expect(risk.memberLoanAccountId).toBe(memberLoanAccountIds[0]);
    expect(risk.message).toMatch(/late/i);
  });

  it('flags RED once more than one full repayment cycle past grace', async () => {
    const { memberLoanAccountIds } = await raiseApproveVerifyAndDisburseLoan(ctx, {
      productOverrides: {
        penaltyRule: {
          calcType: FeeCalcType.FIXED,
          value: 1_000,
          gracePeriodDays: 0,
          frequency: PenaltyFrequency.ONE_TIME,
        },
      },
    });
    await setFirstInstallmentDueDate(memberLoanAccountIds[0]!, FIXED_DUE_DATE);
    const customerId = await customerIdForAccount(memberLoanAccountIds[0]!);

    const risk = await ctx.customerRiskService.getRepaymentRisk(
      customerId,
      referenceDateAt(10), // 10 days past grace(0) > repaymentPeriodDays(7)
    );
    expect(risk.flag).toBe('RED');
    expect(risk.daysPastGrace).toBe(10);
    expect(risk.message).toMatch(/significantly behind/i);
  });

  it('a CHEQUE_PICKUP account gets the same +6-day grace buffer PenaltySweepService applies — still NONE where a TRANSFER account would already be AMBER', async () => {
    const { memberLoanAccountIds } = await raiseApproveVerifyAndDisburseLoan(ctx, {
      disbursementChannel: DisbursementChannel.CHEQUE_PICKUP,
      productOverrides: {
        penaltyRule: {
          calcType: FeeCalcType.FIXED,
          value: 1_000,
          gracePeriodDays: 0,
          frequency: PenaltyFrequency.ONE_TIME,
        },
      },
    });
    await setFirstInstallmentDueDate(memberLoanAccountIds[0]!, FIXED_DUE_DATE);
    const customerId = await customerIdForAccount(memberLoanAccountIds[0]!);

    // daysLate=3, effectiveGrace = 0 + 6 = 6 -> still not past grace at all.
    const risk = await ctx.customerRiskService.getRepaymentRisk(customerId, referenceDateAt(3));
    expect(risk.flag).toBe('NONE');
  });

  it('a fully-paid overdue installment never flags, even with a long-overdue dueDate', async () => {
    const { memberLoanAccountIds } = await raiseApproveVerifyAndDisburseLoan(ctx, {
      productOverrides: {
        penaltyRule: {
          calcType: FeeCalcType.FIXED,
          value: 1_000,
          gracePeriodDays: 0,
          frequency: PenaltyFrequency.ONE_TIME,
        },
      },
    });
    const accountId = memberLoanAccountIds[0]!;
    await setFirstInstallmentDueDate(accountId, FIXED_DUE_DATE);
    const customerId = await customerIdForAccount(accountId);

    const account = await ctx.memberLoanAccountModel.findById(accountId).exec();
    const totalScheduled = account!.schedule.reduce((sum, e) => sum + e.totalDue, 0);
    await recordAndApproveRepayment(ctx, accountId, totalScheduled);

    const risk = await ctx.customerRiskService.getRepaymentRisk(customerId, referenceDateAt(30));
    expect(risk.flag).toBe('NONE');
  });

  it('is scoped per customer — one member being late does not flag another member of the same group loan', async () => {
    // n defaults to 3 — a group's own system-wide minimum size (see
    // GroupsService.validateAndBuildGroupCreationPayload), so this can't be
    // narrowed to just the 2 members this test actually cares about.
    const { customerIds, memberLoanAccountIds } = await raiseApproveVerifyAndDisburseLoan(ctx, {
      productOverrides: {
        penaltyRule: {
          calcType: FeeCalcType.FIXED,
          value: 1_000,
          gracePeriodDays: 0,
          frequency: PenaltyFrequency.ONE_TIME,
        },
      },
    });
    await setFirstInstallmentDueDate(memberLoanAccountIds[0]!, FIXED_DUE_DATE);
    const lateCustomerId = await customerIdForAccount(memberLoanAccountIds[0]!);
    const otherCustomerId = customerIds.find((id) => id !== lateCustomerId)!;

    const lateCustomerRisk = await ctx.customerRiskService.getRepaymentRisk(
      lateCustomerId,
      referenceDateAt(10),
    );
    const otherCustomerRisk = await ctx.customerRiskService.getRepaymentRisk(
      otherCustomerId,
      referenceDateAt(10),
    );
    expect(lateCustomerRisk.flag).toBe('RED');
    expect(otherCustomerRisk.flag).toBe('NONE');
  });

  it('memberLoanAccountId in the result is a real ObjectId string referencing the offending account', async () => {
    const { memberLoanAccountIds } = await raiseApproveVerifyAndDisburseLoan(ctx, {
      productOverrides: {
        penaltyRule: {
          calcType: FeeCalcType.FIXED,
          value: 1_000,
          gracePeriodDays: 0,
          frequency: PenaltyFrequency.ONE_TIME,
        },
      },
    });
    await setFirstInstallmentDueDate(memberLoanAccountIds[0]!, FIXED_DUE_DATE);
    const customerId = await customerIdForAccount(memberLoanAccountIds[0]!);

    const risk = await ctx.customerRiskService.getRepaymentRisk(customerId, referenceDateAt(3));
    expect(Types.ObjectId.isValid(risk.memberLoanAccountId!)).toBe(true);
  });
});
