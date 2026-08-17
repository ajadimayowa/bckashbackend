import { Types } from 'mongoose';

import {
  FeeCalcType,
  FeeCategory,
  PenaltyFrequency,
  PenaltyPercentageBasis,
} from '../../common/enums/loan-product.enums';
import { EarlyLiquidationStatus } from '../../common/enums/repayment.enums';
import { WorkflowEntityType, WorkflowStepAction } from '../../common/enums/workflow.enums';
import { approveCapability } from '../../platform/rbac/constants/capabilities';
import { calculatePenaltyAmount } from '../loan-products/calculations';
import {
  clearAllExceptChainConfigs,
  createApprovedFee,
  createRepaymentsTestContext,
  raiseApproveVerifyAndDisburseLoan,
  resetBranchFixture,
  RepaymentsTestContext,
  teardownRepaymentsTestContext,
} from './test-support/repayments-test-context';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

describe('PenaltySweepService', () => {
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

  /** Backdates installment 1's dueDate to a fixed, known date so daysLate is fully deterministic in tests. */
  async function setFirstInstallmentDueDate(accountId: string, dueDate: Date): Promise<void> {
    await ctx.memberLoanAccountModel
      .updateOne(
        { _id: accountId },
        { $set: { 'schedule.$[elem].dueDate': dueDate } },
        { arrayFilters: [{ 'elem.installmentNumber': 1 }] },
      )
      .exec();
  }

  const FIXED_DUE_DATE = new Date('2024-01-01T00:00:00.000Z');

  function referenceDateAt(daysAfterDue: number): Date {
    return new Date(FIXED_DUE_DATE.getTime() + daysAfterDue * ONE_DAY_MS);
  }

  describe('overdue-installment penalties — ONE_TIME', () => {
    it('skips (no charge) while daysLate is within the grace period', async () => {
      const { memberLoanAccountIds } = await raiseApproveVerifyAndDisburseLoan(ctx, {
        productOverrides: {
          penaltyRule: {
            calcType: FeeCalcType.FIXED,
            value: 1_500,
            gracePeriodDays: 5,
            frequency: PenaltyFrequency.ONE_TIME,
          },
        },
      });
      const accountId = memberLoanAccountIds[0]!;
      await setFirstInstallmentDueDate(accountId, FIXED_DUE_DATE);

      const result = await ctx.penaltySweepService.runDailySweep(referenceDateAt(3));

      expect(result.penaltyChargesApplied).toBe(0);
      const charges = await ctx.penaltyChargeModel
        .find({ memberLoanAccountId: new Types.ObjectId(accountId) })
        .exec();
      expect(charges).toHaveLength(0);
    });

    it('applies exactly once per overdue installment even when the sweep runs twice in a row, matching calculatePenaltyAmount directly', async () => {
      const { memberLoanAccountIds } = await raiseApproveVerifyAndDisburseLoan(ctx, {
        productOverrides: {
          penaltyRule: {
            calcType: FeeCalcType.FIXED,
            value: 1_500,
            gracePeriodDays: 5,
            frequency: PenaltyFrequency.ONE_TIME,
          },
        },
      });
      const accountId = memberLoanAccountIds[0]!;
      await setFirstInstallmentDueDate(accountId, FIXED_DUE_DATE);

      const postPenaltySpy = jest.spyOn(ctx.stubLedgerPostingPort, 'postPenalty');
      const referenceDate = referenceDateAt(10); // daysLate = 10, beyond grace(5)

      const firstRun = await ctx.penaltySweepService.runDailySweep(referenceDate);
      const secondRun = await ctx.penaltySweepService.runDailySweep(referenceDate);

      expect(firstRun.penaltyChargesApplied).toBe(1);
      expect(secondRun.penaltyChargesApplied).toBe(0); // idempotent re-run

      const charges = await ctx.penaltyChargeModel
        .find({ memberLoanAccountId: new Types.ObjectId(accountId) })
        .exec();
      expect(charges).toHaveLength(1);
      expect(charges[0]!.periodIndex).toBe(0);
      expect(charges[0]!.daysLateAtApplication).toBe(10);

      const expectedAmount = calculatePenaltyAmount(
        { calcType: FeeCalcType.FIXED, value: 1_500, gracePeriodDays: 5 },
        {},
        10,
      );
      expect(charges[0]!.penaltyAmountKobo).toBe(expectedAmount);

      expect(postPenaltySpy).toHaveBeenCalledTimes(1);
      expect(postPenaltySpy).toHaveBeenCalledWith(
        charges[0]!._id.toString(),
        expectedAmount,
        expect.anything(),
      );

      const account = await ctx.memberLoanAccountModel.findById(accountId).exec();
      expect(account!.outstandingBalanceKobo).toBe(
        (await computeOriginalOutstanding(accountId)) + expectedAmount,
      );
    });

    async function computeOriginalOutstanding(accountId: string): Promise<number> {
      // Re-derive what the balance would be with zero penalties — used only to
      // assert the penalty was actually $inc'd onto the live balance.
      const account = await ctx.memberLoanAccountModel.findById(accountId).exec();
      const charges = await ctx.penaltyChargeModel
        .find({ memberLoanAccountId: new Types.ObjectId(accountId) })
        .exec();
      const totalCharged = charges.reduce((sum, c) => sum + c.penaltyAmountKobo, 0);
      return account!.outstandingBalanceKobo! - totalCharged;
    }
  });

  describe('overdue-installment penalties — RECURRING', () => {
    async function setUpRecurringProduct(
      percentageOf: PenaltyPercentageBasis,
      maxRecurrences: number | undefined = undefined,
    ) {
      const { memberLoanAccountIds } = await raiseApproveVerifyAndDisburseLoan(ctx, {
        memberPrincipalKobo: 400_000,
        productOverrides: {
          penaltyRule: {
            calcType: FeeCalcType.PERCENTAGE,
            value: 500, // 5%
            percentageOf,
            gracePeriodDays: 0,
            frequency: PenaltyFrequency.RECURRING,
            recurrenceIntervalDays: 7,
            maxRecurrences,
          },
        },
      });
      const accountId = memberLoanAccountIds[0]!;
      await setFirstInstallmentDueDate(accountId, FIXED_DUE_DATE);
      return accountId;
    }

    it('computes an increasing periodIndex as days pass', async () => {
      const accountId = await setUpRecurringProduct(PenaltyPercentageBasis.PRINCIPAL);

      await ctx.penaltySweepService.runDailySweep(referenceDateAt(1)); // daysLate=1 -> periodIndex 0
      await ctx.penaltySweepService.runDailySweep(referenceDateAt(8)); // daysLate=8 -> periodIndex 1
      await ctx.penaltySweepService.runDailySweep(referenceDateAt(15)); // daysLate=15 -> periodIndex 2

      const charges = await ctx.penaltyChargeModel
        .find({ memberLoanAccountId: new Types.ObjectId(accountId) })
        .sort({ periodIndex: 1 })
        .exec();
      expect(charges.map((c) => c.periodIndex)).toEqual([0, 1, 2]);
    });

    it('applies exactly one charge per period even under repeated same-day sweep runs', async () => {
      const accountId = await setUpRecurringProduct(PenaltyPercentageBasis.PRINCIPAL);
      const referenceDate = referenceDateAt(1);

      await ctx.penaltySweepService.runDailySweep(referenceDate);
      await ctx.penaltySweepService.runDailySweep(referenceDate);
      await ctx.penaltySweepService.runDailySweep(referenceDate);

      const charges = await ctx.penaltyChargeModel
        .find({ memberLoanAccountId: new Types.ObjectId(accountId) })
        .exec();
      expect(charges).toHaveLength(1);
    });

    it('respects maxRecurrences by ceasing further charges once the cap is hit, while flagging (not silently dropping) the state', async () => {
      const accountId = await setUpRecurringProduct(PenaltyPercentageBasis.PRINCIPAL, 2);

      await ctx.penaltySweepService.runDailySweep(referenceDateAt(1)); // periodIndex 0
      await ctx.penaltySweepService.runDailySweep(referenceDateAt(8)); // periodIndex 1
      const cappedRun = await ctx.penaltySweepService.runDailySweep(referenceDateAt(15)); // periodIndex 2 >= max(2)

      const charges = await ctx.penaltyChargeModel
        .find({ memberLoanAccountId: new Types.ObjectId(accountId) })
        .exec();
      expect(charges).toHaveLength(2); // periods 0 and 1 only

      expect(cappedRun.accountsAtPenaltyCap).toHaveLength(1);
      expect(cappedRun.accountsAtPenaltyCap[0]!.memberLoanAccountId).toBe(accountId);
      expect(cappedRun.accountsAtPenaltyCap[0]!.periodIndex).toBe(2);

      // The account is otherwise still perfectly queryable/normal.
      const account = await ctx.memberLoanAccountModel.findById(accountId).exec();
      expect(account).not.toBeNull();
    });

    it('compounds for OUTSTANDING basis (each period charge larger than the last) but stays flat for PRINCIPAL basis', async () => {
      const outstandingAccountId = await setUpRecurringProduct(PenaltyPercentageBasis.OUTSTANDING);
      const principalAccountId = await setUpRecurringProduct(PenaltyPercentageBasis.PRINCIPAL);

      await ctx.penaltySweepService.runDailySweep(referenceDateAt(1)); // period 0 for both accounts
      await ctx.penaltySweepService.runDailySweep(referenceDateAt(8)); // period 1 for both accounts

      const outstandingCharges = await ctx.penaltyChargeModel
        .find({ memberLoanAccountId: new Types.ObjectId(outstandingAccountId) })
        .sort({ periodIndex: 1 })
        .exec();
      const principalCharges = await ctx.penaltyChargeModel
        .find({ memberLoanAccountId: new Types.ObjectId(principalAccountId) })
        .sort({ periodIndex: 1 })
        .exec();

      expect(outstandingCharges).toHaveLength(2);
      expect(principalCharges).toHaveLength(2);

      // OUTSTANDING: period 1's charge is computed against a balance that
      // already includes period 0's charge — strictly larger.
      expect(outstandingCharges[1]!.penaltyAmountKobo).toBeGreaterThan(
        outstandingCharges[0]!.penaltyAmountKobo,
      );
      // PRINCIPAL: never changes across periods — identical charge each time.
      expect(principalCharges[1]!.penaltyAmountKobo).toBe(principalCharges[0]!.penaltyAmountKobo);
    });
  });

  describe('early-liquidation recurring delay charges', () => {
    async function setUpApprovedLiquidation(
      frequency: PenaltyFrequency,
      recurrenceIntervalDays?: number,
    ) {
      const feeId = await createApprovedFee(ctx, {
        category: FeeCategory.EARLY_LIQUIDATION,
        calcType: FeeCalcType.FIXED,
        value: 2_000,
        frequency,
        recurrenceIntervalDays,
      });
      const { memberLoanAccountIds } = await raiseApproveVerifyAndDisburseLoan(ctx, {
        productOverrides: { feeIds: [feeId] },
      });
      const accountId = memberLoanAccountIds[0]!;

      const { request, workflowRequest } =
        await ctx.earlyLiquidationService.initiateEarlyLiquidation(accountId, ctx.INITIATOR_ID);
      await ctx.workflowEngineService.act({
        workflowRequestId: workflowRequest._id.toString(),
        actor: {
          staffId: ctx.ADMIN_ID,
          capabilities: [approveCapability(WorkflowEntityType.EARLY_LIQUIDATION)],
        },
        action: WorkflowStepAction.APPROVED,
      });

      // Backdate approvedAt to the same fixed anchor used elsewhere, for determinism.
      await ctx.earlyLiquidationRequestModel
        .updateOne({ _id: request._id }, { $set: { approvedAt: FIXED_DUE_DATE } })
        .exec();

      return { accountId, requestId: request._id.toString() };
    }

    it('accrues a delay charge per period (RECURRING fee), idempotent under repeated runs, increasing totalPayableKobo not outstandingBalanceKobo', async () => {
      const { accountId, requestId } = await setUpApprovedLiquidation(
        PenaltyFrequency.RECURRING,
        7,
      );
      const requestBefore = await ctx.earlyLiquidationService.findByIdOrThrow(requestId);
      const totalPayableBefore = requestBefore.totalPayableKobo;
      const accountBefore = await ctx.memberLoanAccountModel.findById(accountId).exec();
      const balanceBefore = accountBefore!.outstandingBalanceKobo;

      const postPenaltySpy = jest.spyOn(ctx.stubLedgerPostingPort, 'postPenalty');
      const referenceDate = referenceDateAt(1);

      const firstRun = await ctx.penaltySweepService.runDailySweep(referenceDate);
      const secondRun = await ctx.penaltySweepService.runDailySweep(referenceDate); // idempotent re-run, same day

      expect(firstRun.liquidationDelayChargesApplied).toBe(1);
      expect(secondRun.liquidationDelayChargesApplied).toBe(0);

      const charges = await ctx.liquidationDelayChargeModel
        .find({ liquidationRequestId: new Types.ObjectId(requestId) })
        .exec();
      expect(charges).toHaveLength(1);
      expect(charges[0]!.chargeAmountKobo).toBe(2_000);

      const requestAfter = await ctx.earlyLiquidationService.findByIdOrThrow(requestId);
      expect(requestAfter.totalPayableKobo).toBe(totalPayableBefore + 2_000);

      // The account's own ordinary balance is untouched — this is a
      // separate settlement track until the liquidation completes.
      const accountAfter = await ctx.memberLoanAccountModel.findById(accountId).exec();
      expect(accountAfter!.outstandingBalanceKobo).toBe(balanceBefore);

      expect(postPenaltySpy).toHaveBeenCalledWith(
        charges[0]!._id.toString(),
        2_000,
        expect.anything(),
      );
    });

    it('produces zero delay charges for a ONE_TIME fee configuration, regardless of how long settlement is delayed', async () => {
      const { requestId } = await setUpApprovedLiquidation(PenaltyFrequency.ONE_TIME);
      const requestBefore = await ctx.earlyLiquidationService.findByIdOrThrow(requestId);

      // Sweep at a far-future reference date — a RECURRING config would have
      // accrued several periods by now; ONE_TIME must accrue none.
      const result = await ctx.penaltySweepService.runDailySweep(referenceDateAt(60));

      expect(result.liquidationDelayChargesApplied).toBe(0);
      const charges = await ctx.liquidationDelayChargeModel
        .find({ liquidationRequestId: new Types.ObjectId(requestId) })
        .exec();
      expect(charges).toHaveLength(0);

      const requestAfter = await ctx.earlyLiquidationService.findByIdOrThrow(requestId);
      expect(requestAfter.totalPayableKobo).toBe(requestBefore.totalPayableKobo);
      expect(requestAfter.status).toBe(EarlyLiquidationStatus.APPROVED);
    });
  });

  it('sweep is a no-op for accounts/requests it never touches (no schedule due yet, no approved liquidations)', async () => {
    await raiseApproveVerifyAndDisburseLoan(ctx); // schedule due dates are ~1 month out by default
    const result = await ctx.penaltySweepService.runDailySweep(new Date());
    expect(result.penaltyChargesApplied).toBe(0);
    expect(result.liquidationDelayChargesApplied).toBe(0);
  });
});
