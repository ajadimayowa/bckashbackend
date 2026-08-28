import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { LoanStatus, MemberLoanAccountStatus } from '../../common/enums/loan.enums';
import { RepaymentStatus } from '../../common/enums/repayment.enums';
import { CustomerService } from '../customers/customer.service';
import { GroupsService } from '../groups/groups.service';
import { FindLoansFilter, LoanSummary, LoanViewerContext, LoansService } from '../loans/loans.service';
import { PenaltyCharge, PenaltyChargeDocument } from './schemas/penalty-charge.schema';
import { RepaymentRecord, RepaymentRecordDocument } from './schemas/repayment-record.schema';

export interface LoanReportsPortfolioSummary {
  totalLoans: number;
  byStatus: Record<LoanStatus, number>;
  totalDisbursedKobo: number;
  totalOutstandingKobo: number;
  totalInterestKobo: number;
  totalRepaidKobo: number;
}

export interface LoanReportsDelinquencyRow {
  loanId: string;
  customerId: string;
  customerName: string;
  groupId: string;
  groupName: string;
  branchId: string;
  branchName: string | null;
  installmentNumber: number;
  overdueAmountKobo: number;
  penaltyAmountKobo: number;
  daysLateAtApplication: number;
  appliedAt: Date;
}

export interface LoanReportsDelinquency {
  totalOverdueAccounts: number;
  totalOverdueAmountKobo: number;
  totalPenaltyAmountKobo: number;
  atRiskGroupCount: number;
  rows: LoanReportsDelinquencyRow[];
}

export interface LoanReportsCollectionPeriod {
  /** e.g. "2026-W12" — ISO week the bucket represents. */
  periodLabel: string;
  periodStart: Date;
  expectedKobo: number;
  collectedKobo: number;
}

export interface LoanReportsGroupPerformanceRow {
  groupId: string;
  groupName: string;
  branchId: string;
  branchName: string | null;
  memberCount: number;
  totalLoansRaised: number;
  activeLoansCount: number;
  totalDisbursedKobo: number;
  totalOutstandingKobo: number;
  expectedKobo: number;
  collectedKobo: number;
  /** collectedKobo / expectedKobo * 100, rounded — 100 when nothing has been due yet. */
  repaymentRatePercent: number;
}

export interface LoanReportsResult {
  generatedAt: Date;
  portfolioSummary: LoanReportsPortfolioSummary;
  delinquency: LoanReportsDelinquency;
  collection: { weekly: LoanReportsCollectionPeriod[] };
  groupPerformance: LoanReportsGroupPerformanceRow[];
}

const ALL_LOAN_STATUSES = Object.values(LoanStatus);
const COLLECTION_WEEKS = 8;

/** Sunday-anchored ISO-ish week bucket — consistent, calendar-independent grouping, not true ISO 8601 week numbering (that would need a year+week label; this app's reports only ever show a short recent trailing window, so "N weeks back from now" is all that matters). */
function weekStart(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - day);
  return d;
}

function weekLabel(start: Date): string {
  return start.toISOString().slice(0, 10);
}

/**
 * Composes LoansService/RepaymentsModule's own already-row-scoped data into
 * the four "Loan Reports" page sections — no new financial logic of its
 * own, purely aggregation. Lives here (not LoansModule) for the same
 * "module access" reasoning as LoanDetailService/CustomerRiskController —
 * RepaymentRecord/PenaltyCharge are owned by this module, LoansModule
 * can't see them without a cycle (RepaymentsModule already imports
 * LoansModule).
 */
@Injectable()
export class LoanReportsService {
  constructor(
    private readonly loansService: LoansService,
    private readonly groupsService: GroupsService,
    private readonly customerService: CustomerService,
    @InjectModel(RepaymentRecord.name) private readonly repaymentRecordModel: Model<RepaymentRecordDocument>,
    @InjectModel(PenaltyCharge.name) private readonly penaltyChargeModel: Model<PenaltyChargeDocument>,
  ) {}

  async getReports(filter: FindLoansFilter, viewer: LoanViewerContext): Promise<LoanReportsResult> {
    // Reuses LoansService.listForActor's own row-scoping exactly — a
    // Marketer only ever sees loans they raised, a Manager only their own
    // branch's, Admin/SuperAdmin/Approver everything (optionally narrowed
    // by filter.branchId) — so nothing below can ever surface a figure the
    // viewer couldn't otherwise already see loan-by-loan.
    const loans = await this.loansService.listForActor(filter, viewer);

    const portfolioSummary = this.buildPortfolioSummary(loans);

    if (loans.length === 0) {
      return {
        generatedAt: new Date(),
        portfolioSummary,
        delinquency: { totalOverdueAccounts: 0, totalOverdueAmountKobo: 0, totalPenaltyAmountKobo: 0, atRiskGroupCount: 0, rows: [] },
        collection: { weekly: this.emptyWeeklyBuckets() },
        groupPerformance: [],
      };
    }

    const loanIds = loans.map((loan) => new Types.ObjectId(loan.id));
    const accountsPerLoan = await Promise.all(
      loans.map((loan) => this.loansService.getMemberLoanAccounts(loan.id)),
    );
    const accounts = accountsPerLoan.flat();
    const accountIds = accounts.map((account) => account._id);

    const [repayments, penaltyCharges] = await Promise.all([
      this.repaymentRecordModel.find({ loanId: { $in: loanIds } }).exec(),
      accountIds.length > 0
        ? this.penaltyChargeModel.find({ memberLoanAccountId: { $in: accountIds } }).exec()
        : Promise.resolve([]),
    ]);
    const approvedRepayments = repayments.filter((r) => r.status === RepaymentStatus.APPROVED);

    const customerIds = [...new Set(accounts.map((a) => a.customerId.toString()))];
    const customers = await Promise.all(
      customerIds.map((id) => this.customerService.findById(id).catch(() => null)),
    );
    const customerNameById = new Map(
      customers
        .filter((c): c is NonNullable<typeof c> => c !== null)
        .map((c) => [c._id.toString(), `${c.firstName} ${c.lastName}`.trim()]),
    );

    const loanById = new Map(loans.map((loan) => [loan.id, loan]));
    const accountsByLoanId = new Map<string, typeof accounts>();
    for (const account of accounts) {
      const key = account.loanId.toString();
      const list = accountsByLoanId.get(key) ?? [];
      list.push(account);
      accountsByLoanId.set(key, list);
    }
    const accountById = new Map(accounts.map((a) => [a._id.toString(), a]));

    const delinquency = this.buildDelinquency(penaltyCharges, accountById, loanById, customerNameById);
    const collection = this.buildCollection(accounts, approvedRepayments);
    const groupPerformance = await this.buildGroupPerformance(loans, accountsByLoanId, approvedRepayments);

    return { generatedAt: new Date(), portfolioSummary, delinquency, collection: { weekly: collection }, groupPerformance };
  }

  private buildPortfolioSummary(loans: LoanSummary[]): LoanReportsPortfolioSummary {
    const byStatus = Object.fromEntries(ALL_LOAN_STATUSES.map((status) => [status, 0])) as Record<LoanStatus, number>;
    let totalDisbursedKobo = 0;
    let totalOutstandingKobo = 0;
    let totalInterestKobo = 0;

    for (const loan of loans) {
      byStatus[loan.status] += 1;
      if (loan.status === LoanStatus.DISBURSED || loan.status === LoanStatus.CLOSED) {
        totalDisbursedKobo += loan.cumulativeAmountKobo;
        totalInterestKobo += loan.totalInterestKobo;
        totalOutstandingKobo += loan.outstandingBalanceKobo;
      }
    }

    return {
      totalLoans: loans.length,
      byStatus,
      totalDisbursedKobo,
      totalOutstandingKobo,
      totalInterestKobo,
      // Same arithmetic as GroupDetail.tsx's own "Loan Activity" section —
      // what's originally owed minus what's still outstanding.
      totalRepaidKobo: totalDisbursedKobo + totalInterestKobo - totalOutstandingKobo,
    };
  }

  private buildDelinquency(
    penaltyCharges: PenaltyChargeDocument[],
    accountById: Map<string, { loanId: Types.ObjectId; customerId: Types.ObjectId; status: MemberLoanAccountStatus }>,
    loanById: Map<string, LoanSummary>,
    customerNameById: Map<string, string>,
  ): LoanReportsDelinquency {
    const rows: LoanReportsDelinquencyRow[] = [];
    const overdueAccountIds = new Set<string>();
    const atRiskGroupIds = new Set<string>();
    let totalOverdueAmountKobo = 0;
    let totalPenaltyAmountKobo = 0;

    for (const charge of penaltyCharges) {
      const account = accountById.get(charge.memberLoanAccountId.toString());
      // Only still-open accounts count as *currently* delinquent — a charge
      // tied to an account that's since gone CLOSED/DEFAULTED (loan fully
      // wound up one way or the other) is history, not an active concern.
      if (!account || account.status !== MemberLoanAccountStatus.ACTIVE) continue;
      const loan = loanById.get(account.loanId.toString());
      if (!loan) continue;

      overdueAccountIds.add(charge.memberLoanAccountId.toString());
      atRiskGroupIds.add(loan.groupId);
      totalOverdueAmountKobo += charge.overdueAmountKobo;
      totalPenaltyAmountKobo += charge.penaltyAmountKobo;

      rows.push({
        loanId: loan.id,
        customerId: account.customerId.toString(),
        customerName: customerNameById.get(account.customerId.toString()) ?? '—',
        groupId: loan.groupId,
        groupName: loan.groupName,
        branchId: loan.branchId,
        branchName: loan.branchName,
        installmentNumber: charge.scheduleInstallmentNumber,
        overdueAmountKobo: charge.overdueAmountKobo,
        penaltyAmountKobo: charge.penaltyAmountKobo,
        daysLateAtApplication: charge.daysLateAtApplication,
        appliedAt: charge.appliedAt,
      });
    }

    rows.sort((a, b) => b.appliedAt.getTime() - a.appliedAt.getTime());

    return {
      totalOverdueAccounts: overdueAccountIds.size,
      totalOverdueAmountKobo,
      totalPenaltyAmountKobo,
      atRiskGroupCount: atRiskGroupIds.size,
      rows,
    };
  }

  private emptyWeeklyBuckets(): LoanReportsCollectionPeriod[] {
    const buckets: LoanReportsCollectionPeriod[] = [];
    const now = weekStart(new Date());
    for (let i = COLLECTION_WEEKS - 1; i >= 0; i--) {
      const start = new Date(now);
      start.setUTCDate(start.getUTCDate() - i * 7);
      buckets.push({ periodLabel: weekLabel(start), periodStart: start, expectedKobo: 0, collectedKobo: 0 });
    }
    return buckets;
  }

  /**
   * Expected (what's scheduled to be repaid) bucketed by each installment's
   * own dueDate; collected (what's actually come in) bucketed by each
   * approved repayment's own paymentDate — independent sums, not a
   * per-installment reconciliation (see this class's own doc comment: this
   * is a trend report, not a ledger).
   */
  private buildCollection(
    accounts: { schedule: { dueDate: Date; totalDue: number }[] }[],
    approvedRepayments: RepaymentRecordDocument[],
  ): LoanReportsCollectionPeriod[] {
    const buckets = this.emptyWeeklyBuckets();
    const bucketByLabel = new Map(buckets.map((b) => [b.periodLabel, b]));
    const earliestStart = buckets[0]!.periodStart;

    for (const account of accounts) {
      for (const entry of account.schedule) {
        if (entry.dueDate < earliestStart) continue;
        const bucket = bucketByLabel.get(weekLabel(weekStart(entry.dueDate)));
        if (bucket) bucket.expectedKobo += entry.totalDue;
      }
    }
    for (const repayment of approvedRepayments) {
      if (repayment.paymentDate < earliestStart) continue;
      const bucket = bucketByLabel.get(weekLabel(weekStart(repayment.paymentDate)));
      if (bucket) bucket.collectedKobo += repayment.amountKobo;
    }

    return buckets;
  }

  private async buildGroupPerformance(
    loans: LoanSummary[],
    accountsByLoanId: Map<string, { schedule: { totalDue: number }[]; _id: Types.ObjectId }[]>,
    approvedRepayments: RepaymentRecordDocument[],
  ): Promise<LoanReportsGroupPerformanceRow[]> {
    const loansByGroup = new Map<string, LoanSummary[]>();
    for (const loan of loans) {
      const list = loansByGroup.get(loan.groupId) ?? [];
      list.push(loan);
      loansByGroup.set(loan.groupId, list);
    }

    const repaymentsByAccountId = new Map<string, number>();
    for (const repayment of approvedRepayments) {
      const key = repayment.memberLoanAccountId.toString();
      repaymentsByAccountId.set(key, (repaymentsByAccountId.get(key) ?? 0) + repayment.amountKobo);
    }

    const rows = await Promise.all(
      [...loansByGroup.entries()].map(async ([groupId, groupLoans]) => {
        const first = groupLoans[0]!;
        const activeMembers = await this.groupsService.getActiveMembers(groupId).catch(() => []);

        let totalDisbursedKobo = 0;
        let totalOutstandingKobo = 0;
        let activeLoansCount = 0;
        let expectedKobo = 0;
        let collectedKobo = 0;

        for (const loan of groupLoans) {
          if (loan.status === LoanStatus.DISBURSED) activeLoansCount += 1;
          if (loan.status === LoanStatus.DISBURSED || loan.status === LoanStatus.CLOSED) {
            totalDisbursedKobo += loan.cumulativeAmountKobo;
            totalOutstandingKobo += loan.outstandingBalanceKobo;
          }
          for (const account of accountsByLoanId.get(loan.id) ?? []) {
            expectedKobo += account.schedule.reduce((sum, entry) => sum + entry.totalDue, 0);
            collectedKobo += repaymentsByAccountId.get(account._id.toString()) ?? 0;
          }
        }

        return {
          groupId,
          groupName: first.groupName,
          branchId: first.branchId,
          branchName: first.branchName,
          memberCount: activeMembers.length,
          totalLoansRaised: groupLoans.length,
          activeLoansCount,
          totalDisbursedKobo,
          totalOutstandingKobo,
          expectedKobo,
          collectedKobo,
          repaymentRatePercent: expectedKobo > 0 ? Math.round((collectedKobo / expectedKobo) * 100) : 100,
        };
      }),
    );

    return rows.sort((a, b) => b.totalDisbursedKobo - a.totalDisbursedKobo);
  }
}
