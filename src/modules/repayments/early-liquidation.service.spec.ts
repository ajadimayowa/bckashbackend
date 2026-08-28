import { FeeCalcType, FeeCategory } from '../../common/enums/loan-product.enums';
import { MemberLoanAccountStatus } from '../../common/enums/loan.enums';
import { EarlyLiquidationStatus, RepaymentChannel } from '../../common/enums/repayment.enums';
import { WorkflowEntityType, WorkflowStepAction } from '../../common/enums/workflow.enums';
import { approveCapability } from '../../platform/rbac/constants/capabilities';
import { calculateEarlyLiquidationFee } from '../loan-products/calculations';
import {
  clearAllExceptChainConfigs,
  createApprovedFee,
  createRepaymentsTestContext,
  raiseApproveVerifyAndDisburseLoan,
  resetBranchFixture,
  RepaymentsTestContext,
  teardownRepaymentsTestContext,
} from './test-support/repayments-test-context';

describe('EarlyLiquidationService', () => {
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

  async function setUpDisbursedLoanWithLiquidationFee(feeValue = 500) {
    const feeId = await createApprovedFee(ctx, {
      category: FeeCategory.EARLY_LIQUIDATION,
      calcType: FeeCalcType.FIXED,
      value: feeValue,
    });
    const { memberLoanAccountIds } = await raiseApproveVerifyAndDisburseLoan(ctx, {
      productOverrides: { feeIds: [feeId] },
    });
    return { feeId, memberLoanAccountIds };
  }

  async function approveLiquidation(workflowRequestId: string): Promise<void> {
    await ctx.workflowEngineService.act({
      workflowRequestId,
      actor: {
        staffId: ctx.ADMIN_ID,
        capabilities: [approveCapability(WorkflowEntityType.EARLY_LIQUIDATION)],
      },
      action: WorkflowStepAction.APPROVED,
    });
  }

  it('computes the liquidation fee from the balance SNAPSHOT at request time, not a later, different balance', async () => {
    const { memberLoanAccountIds } = await setUpDisbursedLoanWithLiquidationFee(1_000);
    const accountId = memberLoanAccountIds[0]!;
    const accountAtRequest = await ctx.memberLoanAccountModel.findById(accountId).exec();
    const outstandingAtRequest = accountAtRequest!.outstandingBalanceKobo!;

    const { request } = await ctx.earlyLiquidationService.initiateEarlyLiquidation(
      accountId,
      ctx.INITIATOR_ID,
    );

    expect(request.outstandingBalanceAtRequestKobo).toBe(outstandingAtRequest);
    expect(request.liquidationFeeKobo).toBe(1_000);
    expect(request.totalPayableKobo).toBe(outstandingAtRequest + 1_000);

    // Mutate the account's balance AFTER the request — the request's own
    // snapshot must stay untouched.
    await ctx.memberLoanAccountModel
      .updateOne({ _id: accountId }, { $inc: { outstandingBalanceKobo: 50_000 } })
      .exec();

    const reloaded = await ctx.earlyLiquidationService.findByIdOrThrow(request._id.toString());
    expect(reloaded.outstandingBalanceAtRequestKobo).toBe(outstandingAtRequest);
    expect(reloaded.totalPayableKobo).toBe(outstandingAtRequest + 1_000);
  });

  it('completes once a linked, approved repayment meets or exceeds totalPayableKobo', async () => {
    const { memberLoanAccountIds } = await setUpDisbursedLoanWithLiquidationFee(1_000);
    const accountId = memberLoanAccountIds[0]!;

    const { request, workflowRequest } = await ctx.earlyLiquidationService.initiateEarlyLiquidation(
      accountId,
      ctx.INITIATOR_ID,
    );
    await approveLiquidation(workflowRequest._id.toString());

    const approvedRequest = await ctx.earlyLiquidationService.findByIdOrThrow(
      request._id.toString(),
    );
    expect(approvedRequest.status).toBe(EarlyLiquidationStatus.APPROVED);
    expect(approvedRequest.approvedAt).not.toBeNull();

    // Record the settling repayment and link it BEFORE it's approved.
    const { record: repaymentRecord, workflowRequest: repaymentWorkflowRequest } =
      await ctx.repaymentsService.recordRepayment(
        {
          memberLoanAccountId: accountId,
          branchBankAccountId: ctx.branchBankAccountId,
          channel: RepaymentChannel.BANK_TRANSFER,
          transactionReference: `LIQ-${Date.now()}`,
          amountKobo: approvedRequest.totalPayableKobo,
          paymentDate: new Date().toISOString(),
        },
        ctx.INITIATOR_ID,
      );
    await ctx.earlyLiquidationService.linkRepaymentToLiquidation(
      repaymentRecord._id.toString(),
      request._id.toString(),
    );

    await ctx.workflowEngineService.act({
      workflowRequestId: repaymentWorkflowRequest._id.toString(),
      actor: {
        staffId: ctx.REPAYMENT_REVIEWER_ID,
        capabilities: [`workflow:review:${WorkflowEntityType.REPAYMENT_RECORD}`],
      },
      action: WorkflowStepAction.APPROVED,
    });
    await ctx.workflowEngineService.act({
      workflowRequestId: repaymentWorkflowRequest._id.toString(),
      actor: {
        staffId: ctx.REPAYMENT_APPROVER_ID,
        capabilities: [`workflow:approve:${WorkflowEntityType.REPAYMENT_RECORD}`],
      },
      action: WorkflowStepAction.APPROVED,
    });

    const completedRequest = await ctx.earlyLiquidationService.findByIdOrThrow(
      request._id.toString(),
    );
    expect(completedRequest.status).toBe(EarlyLiquidationStatus.COMPLETED);

    const closedAccount = await ctx.memberLoanAccountModel.findById(accountId).exec();
    expect(closedAccount!.outstandingBalanceKobo).toBe(0);
    expect(closedAccount!.status).toBe(MemberLoanAccountStatus.CLOSED);
  });

  it('recordRepayment allows up to an approved liquidation\'s totalPayableKobo, but still rejects beyond it', async () => {
    const { memberLoanAccountIds } = await setUpDisbursedLoanWithLiquidationFee(1_000);
    const accountId = memberLoanAccountIds[0]!;
    const account = await ctx.memberLoanAccountModel.findById(accountId).exec();
    const outstanding = account!.outstandingBalanceKobo!;

    const { request, workflowRequest } = await ctx.earlyLiquidationService.initiateEarlyLiquidation(
      accountId,
      ctx.INITIATOR_ID,
    );
    await approveLiquidation(workflowRequest._id.toString());
    const approvedRequest = await ctx.earlyLiquidationService.findByIdOrThrow(request._id.toString());
    // totalPayableKobo (outstanding + fee) exceeds the plain outstanding
    // balance — recordRepayment must still accept it now that a liquidation
    // for this account has been approved.
    expect(approvedRequest.totalPayableKobo).toBeGreaterThan(outstanding);

    await expect(
      ctx.repaymentsService.recordRepayment(
        {
          memberLoanAccountId: accountId,
          branchBankAccountId: ctx.branchBankAccountId,
          channel: RepaymentChannel.BANK_TRANSFER,
          transactionReference: `LIQ-OK-${Date.now()}`,
          amountKobo: approvedRequest.totalPayableKobo,
          paymentDate: new Date().toISOString(),
        },
        ctx.INITIATOR_ID,
      ),
    ).resolves.toBeDefined();

    // But even the liquidation's own ceiling isn't unlimited.
    await expect(
      ctx.repaymentsService.recordRepayment(
        {
          memberLoanAccountId: accountId,
          branchBankAccountId: ctx.branchBankAccountId,
          channel: RepaymentChannel.BANK_TRANSFER,
          transactionReference: `LIQ-TOOMUCH-${Date.now()}`,
          amountKobo: approvedRequest.totalPayableKobo + 1,
          paymentDate: new Date().toISOString(),
        },
        ctx.INITIATOR_ID,
      ),
    ).rejects.toThrow(/can't be greater than outstanding balance/i);
  });

  it('a short/partial linked payment does NOT complete the liquidation — applies as an ordinary partial repayment instead', async () => {
    const { memberLoanAccountIds } = await setUpDisbursedLoanWithLiquidationFee(1_000);
    const accountId = memberLoanAccountIds[0]!;
    const accountBefore = await ctx.memberLoanAccountModel.findById(accountId).exec();
    const balanceBefore = accountBefore!.outstandingBalanceKobo!;

    const { request, workflowRequest } = await ctx.earlyLiquidationService.initiateEarlyLiquidation(
      accountId,
      ctx.INITIATOR_ID,
    );
    await approveLiquidation(workflowRequest._id.toString());
    const approvedRequest = await ctx.earlyLiquidationService.findByIdOrThrow(
      request._id.toString(),
    );

    // Short of BOTH totalPayableKobo (balance + fee) AND the account's own
    // outstanding balance — otherwise a payment that merely falls short of
    // the fee portion could still fully clear (and close) the ordinary
    // balance via the "balance reaches 0" rule, which isn't what this test
    // is isolating.
    const shortAmount = balanceBefore - 5_000;
    expect(shortAmount).toBeLessThan(approvedRequest.totalPayableKobo);
    const { record: repaymentRecord, workflowRequest: repaymentWorkflowRequest } =
      await ctx.repaymentsService.recordRepayment(
        {
          memberLoanAccountId: accountId,
          branchBankAccountId: ctx.branchBankAccountId,
          channel: RepaymentChannel.BANK_TRANSFER,
          transactionReference: `LIQ-SHORT-${Date.now()}`,
          amountKobo: shortAmount,
          paymentDate: new Date().toISOString(),
        },
        ctx.INITIATOR_ID,
      );
    await ctx.earlyLiquidationService.linkRepaymentToLiquidation(
      repaymentRecord._id.toString(),
      request._id.toString(),
    );
    await ctx.workflowEngineService.act({
      workflowRequestId: repaymentWorkflowRequest._id.toString(),
      actor: {
        staffId: ctx.REPAYMENT_REVIEWER_ID,
        capabilities: [`workflow:review:${WorkflowEntityType.REPAYMENT_RECORD}`],
      },
      action: WorkflowStepAction.APPROVED,
    });
    await ctx.workflowEngineService.act({
      workflowRequestId: repaymentWorkflowRequest._id.toString(),
      actor: {
        staffId: ctx.REPAYMENT_APPROVER_ID,
        capabilities: [`workflow:approve:${WorkflowEntityType.REPAYMENT_RECORD}`],
      },
      action: WorkflowStepAction.APPROVED,
    });

    // Liquidation NOT completed.
    const stillApproved = await ctx.earlyLiquidationService.findByIdOrThrow(request._id.toString());
    expect(stillApproved.status).toBe(EarlyLiquidationStatus.APPROVED);

    // But the repayment DID apply normally, as an ordinary partial repayment.
    const accountAfter = await ctx.memberLoanAccountModel.findById(accountId).exec();
    expect(accountAfter!.outstandingBalanceKobo).toBe(balanceBefore - shortAmount);
    expect(accountAfter!.status).not.toBe(MemberLoanAccountStatus.CLOSED);
  });

  it('calculateEarlyLiquidationFee matches the fee snapshot exactly for a PERCENTAGE fee', async () => {
    const feeId = await createApprovedFee(ctx, {
      category: FeeCategory.EARLY_LIQUIDATION,
      calcType: FeeCalcType.PERCENTAGE,
      value: 250, // 2.5%
      percentageOf: 'OUTSTANDING' as never,
    });
    const { memberLoanAccountIds } = await raiseApproveVerifyAndDisburseLoan(ctx, {
      productOverrides: { feeIds: [feeId] },
    });
    const accountId = memberLoanAccountIds[0]!;
    const account = await ctx.memberLoanAccountModel.findById(accountId).exec();
    const outstanding = account!.outstandingBalanceKobo!;

    const { request } = await ctx.earlyLiquidationService.initiateEarlyLiquidation(
      accountId,
      ctx.INITIATOR_ID,
    );

    const feeDoc = await ctx.feeDefinitionModel.findById(feeId).exec();
    const expectedFee = calculateEarlyLiquidationFee(feeDoc!, outstanding);
    expect(request.liquidationFeeKobo).toBe(expectedFee);
  });
});
