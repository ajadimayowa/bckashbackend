import { Types } from 'mongoose';

import { DisbursementChannel } from '../../common/enums/loan.enums';
import { RepaymentChannel } from '../../common/enums/repayment.enums';
import {
  createApprovedGroup,
  createApprovedProduct,
  createRepaymentsTestContext,
  createVerifiedCustomerWithBiometrics,
  raiseApproveVerifyAndDisburseLoan,
  recordAndApproveRepayment,
  resetBranchFixture,
  RepaymentsTestContext,
  teardownRepaymentsTestContext,
} from './test-support/repayments-test-context';

describe('LoanDetailService', () => {
  let ctx: RepaymentsTestContext;

  beforeAll(async () => {
    ctx = await createRepaymentsTestContext();
  });

  afterAll(async () => {
    await teardownRepaymentsTestContext(ctx);
  });

  beforeEach(async () => {
    await resetBranchFixture(ctx);
  });

  it('assembles a fully disbursed loan — group/product/borrowers/approval/schedule/repayments/activity', async () => {
    const { loanId, groupId, customerIds, product } = await raiseApproveVerifyAndDisburseLoan(ctx, {
      n: 3,
      memberPrincipalKobo: 100_000,
      purpose: 'Working capital for market trading',
    });

    // Partially pay the first installment for just one member.
    const accounts = await ctx.memberLoanAccountModel.find({ loanId: new Types.ObjectId(loanId) }).exec();
    const firstAccount = accounts.find((a) => a.customerId.toString() === customerIds[0])!;
    const firstInstallmentDue = firstAccount.schedule[0]!.totalDue;
    await recordAndApproveRepayment(ctx, firstAccount._id.toString(), firstInstallmentDue);

    const detail = await ctx.loanDetailService.getLoanDetail(loanId);

    expect(detail.id).toBe(loanId);
    expect(detail.status).toBe('DISBURSED');
    expect(detail.purpose).toBe('Working capital for market trading');
    expect(detail.tenureDays).toBe(product.tenureOptions[0]);
    expect(detail.cumulativeAmountKobo).toBe(300_000);
    expect(detail.disbursedAt).not.toBeNull();
    expect(detail.raisedByName).toBeTruthy();

    // Group
    expect(detail.group.id).toBe(groupId);
    expect(detail.group.branchName).toBe('Main');
    expect(detail.group.leaderName).toBeTruthy();
    expect(detail.group.memberCount).toBe(3);

    // Product
    expect(detail.product.id).toBe(product._id.toString());
    expect(detail.product.name).toBe(product.name);
    expect(detail.product.interestRateBasisPoints).toBe(product.interestRate);

    // Borrowers
    expect(detail.borrowers).toHaveLength(3);
    for (const borrower of detail.borrowers) {
      expect(borrower.name).not.toContain('undefined');
      expect(borrower.status).toBe('ACTIVE');
      expect(borrower.verification?.status).toBe('PASSED');
    }

    // Approval workflow — real chain (single approve(LOAN) step per productDto's default fixture).
    expect(detail.approvalWorkflow.length).toBeGreaterThan(0);
    expect(detail.approvalWorkflow.some((s) => s.status === 'APPROVED')).toBe(true);
    expect(detail.pendingWorkflowStatus).toBe('APPROVED');
    expect(detail.pendingWorkflowRequestId).toBeNull();

    // Repayment schedule — one row per repaymentPeriodDays-day installment
    // (7 = weekly, the default — see LoanProduct.repaymentPeriodDays), group
    // totals across both members, first row reflects the one recorded payment.
    expect(detail.repaymentSchedule).toHaveLength(
      Math.ceil(product.tenureOptions[0]! / product.repaymentPeriodDays),
    );
    const firstRow = detail.repaymentSchedule[0]!;
    expect(firstRow.amountPaidKobo).toBe(firstInstallmentDue);
    expect(firstRow.borrowerRows).toHaveLength(3);
    const paidBorrowerRow = firstRow.borrowerRows.find((r) => r.customerId === customerIds[0]);
    expect(paidBorrowerRow?.status).toBe('PAID');
    const unpaidBorrowerRow = firstRow.borrowerRows.find((r) => r.customerId === customerIds[1]);
    expect(unpaidBorrowerRow?.status).toBe('PENDING');
    const laterRow = detail.repaymentSchedule[1]!;
    expect(laterRow.amountPaidKobo).toBe(0);

    // Repayments — the one real transaction recorded above. Its own
    // review/approve chain already ran to completion (recordAndApproveRepayment),
    // so there's nothing left pending for a Manager/Admin to act on here.
    expect(detail.repayments).toHaveLength(1);
    expect(detail.repayments[0]!.amountKobo).toBe(firstInstallmentDue);
    expect(detail.repayments[0]!.status).toBe('APPROVED');
    expect(detail.repayments[0]!.customerName).not.toContain('undefined');
    expect(detail.repayments[0]!.recordedBy).toBe(ctx.INITIATOR_ID);
    expect(detail.repayments[0]!.pendingWorkflowRequestId).toBeNull();

    // Activity — real audit trail entries recorded by LoansService/LoanVerificationService.
    const actions = detail.activity.map((a) => a.action);
    expect(actions).toContain('LOAN_RAISED');
    expect(actions).toContain('LOAN_APPROVED');
    expect(actions).toContain('LOAN_DISBURSED');
  });

  it('leaves approvalWorkflow pending and repaymentSchedule empty for a loan not yet disbursed', async () => {
    // Build a PENDING_APPROVAL loan directly (raiseApproveVerifyAndDisburseLoan
    // always drives all the way to DISBURSED) — same group/product/consent
    // setup, just stopping right after raiseApplication.
    const { groupId: gId, customerIds: cIds } = await createApprovedGroup(
      ctx,
      createVerifiedCustomerWithBiometrics,
      3,
    );
    const product = await createApprovedProduct(ctx);
    const { challengeId } = await ctx.loanConsentService.issueChallenge(cIds[0]!, ctx.INITIATOR_ID);
    const consentLog = await ctx.pendingNotificationLogModel
      .findOne({ recipientCustomerId: new Types.ObjectId(cIds[0]!) })
      .sort({ createdAt: -1 })
      .exec();
    const consentCode = (consentLog?.payload as { code?: string } | undefined)?.code!;

    const raiseResult = await ctx.loansService.raiseApplication(
      gId,
      product._id.toString(),
      product.tenureOptions[0]!,
      cIds.map((customerId) => ({
        customerId,
        requestedAmountKobo: 100_000,
        disbursementChannel: DisbursementChannel.CHEQUE_PICKUP,
      })),
      ctx.INITIATOR_ID,
      challengeId,
      consentCode,
    );

    const detail = await ctx.loanDetailService.getLoanDetail(raiseResult.loan._id.toString());
    expect(detail.status).toBe('PENDING_APPROVAL');
    expect(detail.pendingWorkflowRequestId).not.toBeNull();
    expect(detail.approvalWorkflow.some((s) => s.status === 'PENDING')).toBe(true);
    expect(detail.repaymentSchedule).toHaveLength(0);
    expect(detail.repayments).toHaveLength(0);
    expect(detail.borrowers.every((b) => b.verification === null)).toBe(true);
  });

  it("surfaces a freshly recorded repayment's own pending WorkflowRequest (PENDING_REVIEW), separately from the Loan's own approval chain", async () => {
    const { loanId, customerIds } = await raiseApproveVerifyAndDisburseLoan(ctx, {
      n: 3,
      memberPrincipalKobo: 100_000,
    });
    const accounts = await ctx.memberLoanAccountModel.find({ loanId: new Types.ObjectId(loanId) }).exec();
    const account = accounts.find((a) => a.customerId.toString() === customerIds[0])!;

    const { workflowRequest } = await ctx.repaymentsService.recordRepayment(
      {
        memberLoanAccountId: account._id.toString(),
        branchBankAccountId: ctx.branchBankAccountId,
        channel: RepaymentChannel.BANK_TRANSFER,
        transactionReference: `TXN-${Date.now()}-${Math.random()}`,
        amountKobo: account.schedule[0]!.totalDue,
        paymentDate: new Date().toISOString(),
      },
      ctx.INITIATOR_ID,
    );

    const detail = await ctx.loanDetailService.getLoanDetail(loanId);
    expect(detail.repayments).toHaveLength(1);
    const repayment = detail.repayments[0]!;
    expect(repayment.status).toBe('PENDING');
    expect(repayment.recordedBy).toBe(ctx.INITIATOR_ID);
    expect(repayment.pendingWorkflowRequestId).toBe(workflowRequest._id.toString());
    expect(repayment.pendingWorkflowStatus).toBe('PENDING_REVIEW');

    // The Loan's own chain (already fully APPROVED at disbursement) stays
    // untouched by this — the repayment's chain is a wholly separate one.
    expect(detail.pendingWorkflowRequestId).toBeNull();
  });
});
