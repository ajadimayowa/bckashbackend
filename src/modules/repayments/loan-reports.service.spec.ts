import { Types } from 'mongoose';

import { StaffRole } from '../../common/enums/identity.enums';
import { LoanStatus, MemberLoanAccountStatus } from '../../common/enums/loan.enums';
import { LoanReportsService } from './loan-reports.service';
import {
  clearAllExceptChainConfigs,
  createRepaymentsTestContext,
  raiseApproveVerifyAndDisburseLoan,
  recordAndApproveRepayment,
  resetBranchFixture,
  RepaymentsTestContext,
  teardownRepaymentsTestContext,
} from './test-support/repayments-test-context';

describe('LoanReportsService', () => {
  let ctx: RepaymentsTestContext;
  let service: LoanReportsService;

  beforeAll(async () => {
    ctx = await createRepaymentsTestContext();
    // LoanReportsService isn't part of the shared test context's provider
    // list (it's new, RepaymentsModule-only) — build it directly out of the
    // same moduleRef's already-wired dependencies rather than adding it to
    // every other Phase 9 spec's context.
    service = new LoanReportsService(
      ctx.loansService,
      ctx.groupsService,
      ctx.customerService,
      ctx.repaymentRecordModel,
      ctx.penaltyChargeModel,
    );
  });

  afterAll(async () => {
    await teardownRepaymentsTestContext(ctx);
  });

  beforeEach(async () => {
    await resetBranchFixture(ctx);
  });

  afterEach(async () => {
    // Aggregate, whole-portfolio assertions (unlike loan-detail.service.spec.ts's
    // always-target-one-loanId tests) — without this, an Admin viewer's
    // no-branchId-filter query would keep seeing every prior test's loans too.
    await clearAllExceptChainConfigs(ctx);
  });

  function adminViewer() {
    return { staffId: ctx.ADMIN_ID, role: StaffRole.ADMIN };
  }

  it('returns an empty-but-well-formed result when the viewer has no visible loans', async () => {
    const result = await service.getReports({}, adminViewer());

    expect(result.portfolioSummary.totalLoans).toBe(0);
    expect(result.portfolioSummary.totalDisbursedKobo).toBe(0);
    expect(result.delinquency).toEqual({
      totalOverdueAccounts: 0,
      totalOverdueAmountKobo: 0,
      totalPenaltyAmountKobo: 0,
      atRiskGroupCount: 0,
      rows: [],
    });
    expect(result.collection.weekly).toHaveLength(8);
    expect(result.collection.weekly.every((w) => w.expectedKobo === 0 && w.collectedKobo === 0)).toBe(true);
    expect(result.groupPerformance).toEqual([]);
  });

  it('builds portfolio summary, delinquency, weekly collection, and group performance for a disbursed loan', async () => {
    const { loanId, groupId, customerIds } = await raiseApproveVerifyAndDisburseLoan(ctx, {
      n: 3,
      memberPrincipalKobo: 100_000,
    });

    const accounts = await ctx.memberLoanAccountModel.find({ loanId: new Types.ObjectId(loanId) }).exec();
    const paidAccount = accounts.find((a) => a.customerId.toString() === customerIds[0])!;
    const overdueAccount = accounts.find((a) => a.customerId.toString() === customerIds[1])!;

    // Backdate the first installment's dueDate into "now" — a freshly
    // disbursed loan's real schedule starts a repaymentPeriodDays out into
    // the future, which the weekly collection trend (a trailing, not
    // forward-looking, window — see buildCollection's own doc comment)
    // wouldn't have picked up yet.
    const firstInstallmentDue = paidAccount.schedule[0]!.totalDue;
    await ctx.memberLoanAccountModel.updateOne(
      { _id: paidAccount._id },
      { $set: { 'schedule.0.dueDate': new Date() } },
    );
    await recordAndApproveRepayment(ctx, paidAccount._id.toString(), firstInstallmentDue);

    // Simulate what PenaltySweepService would have created for the second
    // member's still-unpaid first installment — exercised directly rather
    // than driving the whole nightly sweep, same as this class's own
    // "delinquency" section only reads PenaltyCharge, never derives it.
    await ctx.penaltyChargeModel.create({
      memberLoanAccountId: overdueAccount._id,
      scheduleInstallmentNumber: 1,
      periodIndex: 0,
      overdueAmountKobo: overdueAccount.schedule[0]!.totalDue,
      daysLateAtApplication: 3,
      penaltyAmountKobo: 1_000,
      appliedAt: new Date(),
    });

    const result = await service.getReports({}, adminViewer());

    // Portfolio summary
    expect(result.portfolioSummary.totalLoans).toBe(1);
    expect(result.portfolioSummary.byStatus[LoanStatus.DISBURSED]).toBe(1);
    expect(result.portfolioSummary.totalDisbursedKobo).toBe(300_000);
    expect(result.portfolioSummary.totalInterestKobo).toBeGreaterThan(0);
    expect(result.portfolioSummary.totalRepaidKobo).toBe(
      result.portfolioSummary.totalDisbursedKobo +
        result.portfolioSummary.totalInterestKobo -
        result.portfolioSummary.totalOutstandingKobo,
    );

    // Delinquency — only the still-ACTIVE overdue account shows up.
    expect(result.delinquency.totalOverdueAccounts).toBe(1);
    expect(result.delinquency.totalPenaltyAmountKobo).toBe(1_000);
    expect(result.delinquency.atRiskGroupCount).toBe(1);
    expect(result.delinquency.rows).toHaveLength(1);
    const row = result.delinquency.rows[0]!;
    expect(row.loanId).toBe(loanId);
    expect(row.groupId).toBe(groupId);
    expect(row.customerId).toBe(overdueAccount.customerId.toString());
    expect(row.customerName).not.toContain('undefined');
    expect(row.penaltyAmountKobo).toBe(1_000);

    // Weekly collection — this week's bucket carries the one approved payment.
    expect(result.collection.weekly).toHaveLength(8);
    const totalCollected = result.collection.weekly.reduce((sum, w) => sum + w.collectedKobo, 0);
    expect(totalCollected).toBe(firstInstallmentDue);
    const totalExpected = result.collection.weekly.reduce((sum, w) => sum + w.expectedKobo, 0);
    expect(totalExpected).toBeGreaterThan(0);

    // Group performance
    expect(result.groupPerformance).toHaveLength(1);
    const groupRow = result.groupPerformance[0]!;
    expect(groupRow.groupId).toBe(groupId);
    expect(groupRow.memberCount).toBe(3);
    expect(groupRow.totalLoansRaised).toBe(1);
    expect(groupRow.activeLoansCount).toBe(1);
    expect(groupRow.totalDisbursedKobo).toBe(300_000);
    expect(groupRow.collectedKobo).toBe(firstInstallmentDue);
    expect(groupRow.repaymentRatePercent).toBeGreaterThanOrEqual(0);
    expect(groupRow.repaymentRatePercent).toBeLessThanOrEqual(100);
  });

  it('drops a delinquency row once its account is no longer ACTIVE', async () => {
    const { customerIds } = await raiseApproveVerifyAndDisburseLoan(ctx, { n: 3, memberPrincipalKobo: 100_000 });
    const accounts = await ctx.memberLoanAccountModel
      .find({ customerId: { $in: customerIds.map((id) => new Types.ObjectId(id)) } })
      .exec();
    const account = accounts[0]!;

    await ctx.penaltyChargeModel.create({
      memberLoanAccountId: account._id,
      scheduleInstallmentNumber: 1,
      periodIndex: 0,
      overdueAmountKobo: account.schedule[0]!.totalDue,
      daysLateAtApplication: 5,
      penaltyAmountKobo: 1_000,
      appliedAt: new Date(),
    });

    // Wind the account down (as DisbursementService/EarlyLiquidationService
    // would on payoff/default) — the sweep already ran while it was ACTIVE,
    // but a closed account isn't a *current* delinquency concern any more.
    await ctx.memberLoanAccountModel.updateOne(
      { _id: account._id },
      { $set: { status: MemberLoanAccountStatus.CLOSED } },
    );

    const result = await service.getReports({}, adminViewer());
    expect(result.delinquency.totalOverdueAccounts).toBe(0);
    expect(result.delinquency.rows).toHaveLength(0);
  });

  it('row-scopes exactly like LoansService.listForActor — a Marketer who raised nothing sees an empty report', async () => {
    await raiseApproveVerifyAndDisburseLoan(ctx, { n: 3, memberPrincipalKobo: 100_000 });

    const otherMarketerId = new Types.ObjectId().toString();
    const result = await service.getReports(
      {},
      { staffId: otherMarketerId, role: StaffRole.MARKETER, branchId: ctx.branchId },
    );

    expect(result.portfolioSummary.totalLoans).toBe(0);
    expect(result.groupPerformance).toEqual([]);
  });

  it("row-scopes a Manager to only their own branch's loans", async () => {
    await raiseApproveVerifyAndDisburseLoan(ctx, { n: 3, memberPrincipalKobo: 100_000 });
    const otherBranchId = new Types.ObjectId().toString();

    const result = await service.getReports(
      {},
      { staffId: new Types.ObjectId().toString(), role: StaffRole.MANAGER, branchId: otherBranchId },
    );

    expect(result.portfolioSummary.totalLoans).toBe(0);
  });

  it('lets an Admin see everything and narrow by branchId', async () => {
    await raiseApproveVerifyAndDisburseLoan(ctx, { n: 3, memberPrincipalKobo: 100_000 });

    const allBranches = await service.getReports({}, adminViewer());
    expect(allBranches.portfolioSummary.totalLoans).toBe(1);

    const wrongBranch = await service.getReports({ branchId: new Types.ObjectId().toString() }, adminViewer());
    expect(wrongBranch.portfolioSummary.totalLoans).toBe(0);

    const rightBranch = await service.getReports({ branchId: ctx.branchId }, adminViewer());
    expect(rightBranch.portfolioSummary.totalLoans).toBe(1);
  });
});
