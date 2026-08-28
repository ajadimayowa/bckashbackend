import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { StaffRole } from '../../common/enums/identity.enums';
import {
  DisbursementChannel,
  DisbursementVerificationStatus,
  LoanStatus,
  MemberLoanAccountStatus,
} from '../../common/enums/loan.enums';
import { RepaymentChannel, RepaymentStatus } from '../../common/enums/repayment.enums';
import { WorkflowStatus, WorkflowStepAction } from '../../common/enums/workflow.enums';
import { WorkflowEngineService } from '../../platform/workflow-engine/workflow-engine.service';
import { CustomerService } from '../customers/customer.service';
import { GroupsService } from '../groups/groups.service';
import { LoanProductsService } from '../loan-products/loan-products.service';
import { BankAccountDetails } from '../loans/schemas/member-loan-account.schema';
import { LoanVerificationService } from '../loans/loan-verification.service';
import { LoansService } from '../loans/loans.service';
import { RepaymentsService } from './repayments.service';
import { PenaltyCharge, PenaltyChargeDocument } from './schemas/penalty-charge.schema';
import { RepaymentRecordDocument } from './schemas/repayment-record.schema';

export interface LoanDetailPenaltyCharge {
  id: string;
  memberLoanAccountId: string;
  customerId: string;
  customerName: string;
  scheduleInstallmentNumber: number;
  overdueAmountKobo: number;
  daysLateAtApplication: number;
  penaltyAmountKobo: number;
  appliedAt: Date;
}

/** One row for the standalone "Loan Repayments" list page — row-scoped like RepaymentsService.listForActor. */
export interface RepaymentListItem {
  id: string;
  loanId: string;
  groupId: string;
  groupName: string;
  customerId: string;
  customerName: string;
  branchId: string;
  branchName: string | null;
  amountKobo: number;
  channel: RepaymentChannel;
  transactionReference: string;
  paymentDate: Date;
  status: RepaymentStatus;
  recordedBy: string;
  recordedByName: string | null;
  /** This repayment's own pending review/approval WorkflowRequest, if any — same shape as LoanDetailRepayment's own field. */
  pendingWorkflowRequestId: string | null;
  pendingWorkflowStatus: WorkflowStatus | null;
}

export interface LoanDetailBorrowerVerification {
  status: DisbursementVerificationStatus;
  bvnStatus: 'PASSED' | 'FAILED' | null;
  facialMatchStatus: 'PASSED' | 'FAILED' | null;
  similarityPercent: number | null;
  escalationReason: string | null;
}

export interface LoanDetailBorrower {
  memberLoanAccountId: string;
  customerId: string;
  name: string;
  phoneNumber: string;
  principalAmountKobo: number;
  disbursementChannel: DisbursementChannel;
  bankAccountDetails: BankAccountDetails | null;
  applicantPhotoImageKey: string | null;
  status: MemberLoanAccountStatus;
  outstandingBalanceKobo: number | null;
  kycStatus: string;
  chequeHandedOverAt: Date | null;
  verification: LoanDetailBorrowerVerification | null;
}

export interface LoanDetailApprovalStep {
  order: number;
  requiredCapability: string;
  status: WorkflowStepAction | 'PENDING';
  actedByName: string | null;
  actedAt: Date | null;
  comment: string | null;
}

export interface LoanDetailScheduleBorrowerRow {
  customerId: string;
  name: string;
  principalKobo: number;
  interestKobo: number;
  totalDueKobo: number;
  amountPaidKobo: number;
  balanceKobo: number;
  status: 'PAID' | 'PARTIAL' | 'PENDING';
}

export interface LoanDetailScheduleRow {
  installmentNumber: number;
  dueDate: Date;
  principalKobo: number;
  interestKobo: number;
  totalDueKobo: number;
  amountPaidKobo: number;
  balanceKobo: number;
  status: 'PAID' | 'PARTIAL' | 'PENDING';
  borrowerRows: LoanDetailScheduleBorrowerRow[];
}

export interface LoanDetailRepayment {
  id: string;
  memberLoanAccountId: string;
  customerId: string;
  customerName: string;
  amountKobo: number;
  channel: RepaymentChannel;
  transactionReference: string;
  paymentDate: Date;
  status: RepaymentStatus;
  recordedBy: string;
  recordedByName: string | null;
  /** The pending WorkflowRequest currently driving this repayment's own review/approval chain, if any — same "act on this id via the generic workflow-requests endpoint" shape as LoanDetailResponse.pendingWorkflowRequestId, just per-repayment rather than per-loan. */
  pendingWorkflowRequestId: string | null;
  pendingWorkflowStatus: WorkflowStatus | null;
}

export interface LoanDetailActivityEntry {
  action: string;
  date: Date;
  byName: string;
}

export interface LoanDetailResponse {
  id: string;
  status: LoanStatus;
  purpose: string | null;
  tenureDays: number;
  cumulativeAmountKobo: number;
  /** Sum of every member's schedule totalDue — the full amount expected back, principal + interest, once disbursed (0 before then). */
  totalRepayableKobo: number;
  /** totalRepayableKobo minus cumulativeAmountKobo. */
  totalInterestKobo: number;
  /** Sum of every member's current outstandingBalanceKobo. */
  outstandingBalanceKobo: number;
  raisedAt: Date;
  approvedAt: Date | null;
  disbursedAt: Date | null;
  raisedBy: string;
  raisedByName: string;
  group: {
    id: string;
    name: string;
    branchId: string;
    branchName: string | null;
    leaderName: string | null;
    memberCount: number;
  };
  product: {
    id: string;
    name: string;
    interestRateBasisPoints: number;
    interestType: string;
    tenureOptions: number[];
  };
  /** The pending WorkflowRequest currently driving `approvalWorkflow`, if any — the frontend acts on this id via the generic workflow-requests `act` endpoint. */
  pendingWorkflowRequestId: string | null;
  pendingWorkflowStatus: WorkflowStatus | null;
  borrowers: LoanDetailBorrower[];
  approvalWorkflow: LoanDetailApprovalStep[];
  repaymentSchedule: LoanDetailScheduleRow[];
  repayments: LoanDetailRepayment[];
  /** Every penalty charge applied against this loan's members — see PenaltySweepService, which applies these automatically once an installment goes overdue past its grace period. */
  penalties: LoanDetailPenaltyCharge[];
  activity: LoanDetailActivityEntry[];
}

/**
 * Composes everything the Loan Manager's LoanDetail page needs into one
 * response — Loan/MemberLoanAccount (loans module), the real approval trail
 * (generic workflow-engine, not a fixed 3-stage pipeline — see
 * WorkflowEngineService.getHistory), real repayment records (this module),
 * and real per-member disbursement verification (loans module). Lives here
 * rather than in LoansModule because RepaymentsModule already sits "above"
 * both LoansModule and its own RepaymentRecord collection — see
 * RepaymentsModule's own import comment; putting this in LoansModule would
 * need it to import RepaymentsModule back, which already imports LoansModule
 * (a cycle).
 *
 * `repaymentSchedule[].amountPaidKobo`/`balanceKobo` (and the matching
 * per-borrower rows) are a DISPLAY-ONLY computation, not a persisted
 * allocation: the real system tracks one running `outstandingBalanceKobo`
 * per MemberLoanAccount, not a per-installment paid amount (see
 * RepaymentRecord's own schema comment — it isn't linked to a specific
 * schedule entry). This applies each customer's own APPROVED repayments,
 * oldest first, against their own schedule rows in installment order
 * (a FIFO allocation) purely so the UI has something concrete to show per
 * row; it is never used to decide anything financial.
 */
@Injectable()
export class LoanDetailService {
  constructor(
    private readonly loansService: LoansService,
    private readonly loanVerificationService: LoanVerificationService,
    private readonly repaymentsService: RepaymentsService,
    private readonly loanProductsService: LoanProductsService,
    private readonly groupsService: GroupsService,
    private readonly customerService: CustomerService,
    private readonly workflowEngineService: WorkflowEngineService,
    @InjectModel(PenaltyCharge.name) private readonly penaltyChargeModel: Model<PenaltyChargeDocument>,
  ) {}

  async getLoanDetail(loanId: string): Promise<LoanDetailResponse> {
    const loan = await this.loansService.findByIdOrThrow(loanId);
    const [accounts, verifications, repayments, product, group, workflowHistory, penaltyCharges] = await Promise.all([
      this.loansService.getMemberLoanAccounts(loanId),
      this.loanVerificationService.getVerificationsForLoan(loanId),
      this.repaymentsService.listForLoan(loanId),
      this.loanProductsService.findByIdOrThrow(loan.productId.toString()),
      this.groupsService.findById(loan.groupId.toString()),
      this.workflowEngineService.getHistory('LOAN', loanId),
      this.getPenaltyChargesForLoan(loanId),
    ]);

    const customerIds = accounts.map((a) => a.customerId.toString());
    const [customers, staffNamesById, branchNamesById, leadership, activeMembers] = await Promise.all([
      Promise.all(customerIds.map((id) => this.customerService.findById(id).catch(() => null))),
      this.customerService.resolveStaffNames([
        loan.raisedBy.toString(),
        ...workflowHistory.flatMap((r) => r.steps.map((s) => s.actedBy).filter((v): v is string => Boolean(v))),
        ...repayments.map((r) => r.recordedBy.toString()),
      ]),
      this.groupsService.resolveBranchNames([group.branchId.toString()]),
      this.groupsService.getLeadership(group._id.toString()),
      this.groupsService.getActiveMembers(group._id.toString()),
    ]);
    const customerById = new Map(
      customers.filter((c): c is NonNullable<typeof c> => c !== null).map((c) => [c._id.toString(), c]),
    );
    const verificationByAccountId = new Map(verifications.map((v) => [v.memberLoanAccountId.toString(), v]));

    const leaderMembership = leadership.head ?? null;
    const leaderCustomer = leaderMembership
      ? (customerById.get(leaderMembership.customerId.toString()) ??
        (await this.customerService.findById(leaderMembership.customerId.toString()).catch(() => null)))
      : null;

    const borrowers: LoanDetailBorrower[] = accounts.map((account) => {
      const customer = customerById.get(account.customerId.toString()) ?? null;
      const verification = verificationByAccountId.get(account._id.toString()) ?? null;
      return {
        memberLoanAccountId: account._id.toString(),
        customerId: account.customerId.toString(),
        name: customer ? `${customer.firstName} ${customer.lastName}`.trim() : `Customer ${account.customerId.toString().slice(-6)}`,
        phoneNumber: customer?.phoneNumber ?? '—',
        principalAmountKobo: account.principalAmountKobo,
        disbursementChannel: account.disbursementChannel,
        bankAccountDetails: account.bankAccountDetails,
        applicantPhotoImageKey: account.applicantPhotoImageKey,
        status: account.status,
        outstandingBalanceKobo: account.outstandingBalanceKobo,
        kycStatus: customer?.kycStatus ?? 'UNKNOWN',
        chequeHandedOverAt: account.chequeHandedOverAt,
        verification: verification
          ? {
              status: verification.status,
              bvnStatus: verification.bvnRecheck?.status ?? null,
              facialMatchStatus: verification.facialMatch?.status ?? null,
              similarityPercent: verification.facialMatch?.similarityPercent ?? null,
              escalationReason: verification.escalationReason,
            }
          : null,
      };
    });

    const accountById = new Map(accounts.map((a) => [a._id.toString(), a]));
    const penalties: LoanDetailPenaltyCharge[] = penaltyCharges.map((charge) => {
      const account = accountById.get(charge.memberLoanAccountId.toString());
      const customer = account ? (customerById.get(account.customerId.toString()) ?? null) : null;
      return {
        id: charge._id.toString(),
        memberLoanAccountId: charge.memberLoanAccountId.toString(),
        customerId: account?.customerId.toString() ?? '',
        customerName: customer ? `${customer.firstName} ${customer.lastName}`.trim() : '—',
        scheduleInstallmentNumber: charge.scheduleInstallmentNumber,
        overdueAmountKobo: charge.overdueAmountKobo,
        daysLateAtApplication: charge.daysLateAtApplication,
        penaltyAmountKobo: charge.penaltyAmountKobo,
        appliedAt: charge.appliedAt,
      };
    });

    const totalRepayableKobo = accounts.reduce(
      (sum, a) => sum + a.schedule.reduce((s, entry) => s + entry.totalDue, 0),
      0,
    );
    const outstandingBalanceKobo = accounts.reduce((sum, a) => sum + (a.outstandingBalanceKobo ?? 0), 0);

    // Only ever one WorkflowRequest per Loan in practice (see Loan schema's
    // own doc comment — a Loan is never resubmitted/re-initiated), but take
    // the most recent defensively rather than assume.
    const currentRequest = workflowHistory[workflowHistory.length - 1] ?? null;
    const approvalWorkflow: LoanDetailApprovalStep[] = currentRequest
      ? currentRequest.steps.map((step) => ({
          order: step.order,
          requiredCapability: step.requiredCapability,
          status: step.action ?? 'PENDING',
          actedByName: step.actedBy ? (staffNamesById.get(step.actedBy) ?? step.actedBy) : null,
          actedAt: step.actedAt,
          comment: step.comment,
        }))
      : [];
    const isPendingRequest =
      currentRequest?.status === WorkflowStatus.PENDING_REVIEW ||
      currentRequest?.status === WorkflowStatus.PENDING_APPROVAL ||
      currentRequest?.status === WorkflowStatus.RETURNED_TO_MAKER;

    const repaymentSchedule = this.buildRepaymentSchedule(accounts, repayments, customerById);

    const pendingRepaymentWorkflowById = await this.resolvePendingRepaymentWorkflows(repayments);

    const repaymentEntries: LoanDetailRepayment[] = repayments.map((r) => {
      const customer = customerById.get(r.customerId.toString()) ?? null;
      const pending = pendingRepaymentWorkflowById.get(r._id.toString()) ?? {
        pendingWorkflowRequestId: null,
        pendingWorkflowStatus: null,
      };
      return {
        id: r._id.toString(),
        memberLoanAccountId: r.memberLoanAccountId.toString(),
        customerId: r.customerId.toString(),
        customerName: customer ? `${customer.firstName} ${customer.lastName}`.trim() : r.customerId.toString(),
        amountKobo: r.amountKobo,
        channel: r.channel,
        transactionReference: r.transactionReference,
        paymentDate: r.paymentDate,
        status: r.status,
        recordedBy: r.recordedBy.toString(),
        recordedByName: staffNamesById.get(r.recordedBy.toString()) ?? null,
        ...pending,
      };
    });

    const activityEntries = await this.buildActivity(loanId, staffNamesById);

    return {
      id: loan._id.toString(),
      status: loan.status,
      purpose: loan.purpose,
      tenureDays: loan.tenureDays,
      cumulativeAmountKobo: loan.cumulativeAmountKobo,
      totalRepayableKobo,
      totalInterestKobo: totalRepayableKobo - loan.cumulativeAmountKobo,
      outstandingBalanceKobo,
      raisedAt: loan.raisedAt,
      approvedAt: loan.approvedAt,
      disbursedAt: loan.disbursedAt,
      raisedBy: loan.raisedBy.toString(),
      raisedByName: staffNamesById.get(loan.raisedBy.toString()) ?? loan.raisedBy.toString(),
      group: {
        id: group._id.toString(),
        name: group.name,
        branchId: group.branchId.toString(),
        branchName: branchNamesById.get(group.branchId.toString()) ?? null,
        leaderName: leaderCustomer ? `${leaderCustomer.firstName} ${leaderCustomer.lastName}`.trim() : null,
        memberCount: activeMembers.length,
      },
      product: {
        id: product._id.toString(),
        name: product.name,
        interestRateBasisPoints: product.interestRate,
        interestType: product.interestType,
        tenureOptions: product.tenureOptions,
      },
      pendingWorkflowRequestId: isPendingRequest && currentRequest ? currentRequest._id.toString() : null,
      pendingWorkflowStatus: currentRequest?.status ?? null,
      borrowers,
      approvalWorkflow,
      repaymentSchedule,
      repayments: repaymentEntries,
      penalties,
      activity: activityEntries,
    };
  }

  /**
   * `{ pendingWorkflowRequestId, pendingWorkflowStatus }` per repayment id —
   * one batched getHistoryForEntities query instead of one getHistory call
   * per row, shared by both getLoanDetail's repaymentEntries and
   * listRepaymentsForActor's rows (see LoanDetailRepayment/RepaymentListItem's
   * own doc comments for what these two fields mean).
   */
  private async resolvePendingRepaymentWorkflows(
    repayments: RepaymentRecordDocument[],
  ): Promise<Map<string, { pendingWorkflowRequestId: string | null; pendingWorkflowStatus: WorkflowStatus | null }>> {
    const requests = await this.workflowEngineService.getHistoryForEntities(
      'REPAYMENT_RECORD',
      repayments.map((r) => r._id.toString()),
    );
    const requestsByRepaymentId = new Map<string, typeof requests>();
    for (const request of requests) {
      const key = request.entityId ?? '';
      const list = requestsByRepaymentId.get(key) ?? [];
      list.push(request);
      requestsByRepaymentId.set(key, list);
    }

    const result = new Map<
      string,
      { pendingWorkflowRequestId: string | null; pendingWorkflowStatus: WorkflowStatus | null }
    >();
    for (const repayment of repayments) {
      const id = repayment._id.toString();
      // A repayment is (per RepaymentsService.recordRepayment) only ever
      // initiated once, so there's at most one WorkflowRequest per id in
      // practice, but this picks the most recent defensively.
      const list = requestsByRepaymentId.get(id) ?? [];
      const current = list[list.length - 1] ?? null;
      const isPending =
        current?.status === WorkflowStatus.PENDING_REVIEW ||
        current?.status === WorkflowStatus.PENDING_APPROVAL ||
        current?.status === WorkflowStatus.RETURNED_TO_MAKER;
      result.set(id, {
        pendingWorkflowRequestId: isPending && current ? current._id.toString() : null,
        pendingWorkflowStatus: current?.status ?? null,
      });
    }
    return result;
  }

  private async getPenaltyChargesForLoan(loanId: string): Promise<PenaltyChargeDocument[]> {
    const accounts = await this.loansService.getMemberLoanAccounts(loanId);
    if (accounts.length === 0) return [];
    return this.penaltyChargeModel
      .find({ memberLoanAccountId: { $in: accounts.map((a) => a._id) } })
      .sort({ appliedAt: -1 })
      .exec();
  }

  /** Row-scoped standalone repayments list — see RepaymentsService.listForActor's own doc comment. */
  async listRepaymentsForActor(
    filter: { branchId?: string; loanId?: string; status?: RepaymentStatus },
    viewer: { staffId: string; role: StaffRole; branchId?: string },
  ): Promise<RepaymentListItem[]> {
    const records = await this.repaymentsService.listForActor(filter, viewer);
    if (records.length === 0) return [];

    const loanIds = [...new Set(records.map((r) => r.loanId.toString()))];
    const loans = await Promise.all(loanIds.map((id) => this.loansService.findByIdOrThrow(id).catch(() => null)));
    const loanById = new Map(
      loans.filter((l): l is NonNullable<typeof l> => l !== null).map((l) => [l._id.toString(), l]),
    );

    const groupIds = [...new Set([...loanById.values()].map((l) => l.groupId.toString()))];
    const groups = await Promise.all(groupIds.map((id) => this.groupsService.findById(id).catch(() => null)));
    const groupById = new Map(
      groups.filter((g): g is NonNullable<typeof g> => g !== null).map((g) => [g._id.toString(), g]),
    );

    const customerIds = [...new Set(records.map((r) => r.customerId.toString()))];
    const customers = await Promise.all(customerIds.map((id) => this.customerService.findById(id).catch(() => null)));
    const customerById = new Map(
      customers.filter((c): c is NonNullable<typeof c> => c !== null).map((c) => [c._id.toString(), c]),
    );

    const branchIds = [...new Set(records.map((r) => r.branchId.toString()))];
    const branchNamesById = await this.groupsService.resolveBranchNames(branchIds);
    const staffNamesById = await this.customerService.resolveStaffNames(
      records.map((r) => r.recordedBy.toString()),
    );
    const pendingWorkflowById = await this.resolvePendingRepaymentWorkflows(records);

    return records.map((r): RepaymentListItem => {
      const loan = loanById.get(r.loanId.toString()) ?? null;
      const group = loan ? (groupById.get(loan.groupId.toString()) ?? null) : null;
      const customer = customerById.get(r.customerId.toString()) ?? null;
      const pending = pendingWorkflowById.get(r._id.toString()) ?? {
        pendingWorkflowRequestId: null,
        pendingWorkflowStatus: null,
      };
      return {
        id: r._id.toString(),
        loanId: r.loanId.toString(),
        groupId: loan?.groupId.toString() ?? '',
        groupName: group?.name ?? '—',
        customerId: r.customerId.toString(),
        customerName: customer ? `${customer.firstName} ${customer.lastName}`.trim() : r.customerId.toString(),
        branchId: r.branchId.toString(),
        branchName: branchNamesById.get(r.branchId.toString()) ?? null,
        amountKobo: r.amountKobo,
        channel: r.channel,
        transactionReference: r.transactionReference,
        paymentDate: r.paymentDate,
        status: r.status,
        recordedBy: r.recordedBy.toString(),
        recordedByName: staffNamesById.get(r.recordedBy.toString()) ?? null,
        ...pending,
      };
    });
  }

  /**
   * Group-level schedule rows (summed across every member's own schedule at
   * the same installmentNumber) plus a per-borrower breakdown — see this
   * class's own doc comment for why amountPaid/balance here is a display-only
   * FIFO allocation, not a persisted figure.
   */
  private buildRepaymentSchedule(
    accounts: Awaited<ReturnType<LoansService['getMemberLoanAccounts']>>,
    repayments: RepaymentRecordDocument[],
    customerById: Map<string, { firstName: string; lastName: string }>,
  ): LoanDetailScheduleRow[] {
    const repaymentsByAccount = new Map<string, RepaymentRecordDocument[]>();
    for (const repayment of repayments) {
      if (repayment.status !== RepaymentStatus.APPROVED) continue;
      const key = repayment.memberLoanAccountId.toString();
      const list = repaymentsByAccount.get(key) ?? [];
      list.push(repayment);
      repaymentsByAccount.set(key, list);
    }

    const maxInstallments = Math.max(0, ...accounts.map((a) => a.schedule.length));
    const rows: LoanDetailScheduleRow[] = [];

    for (let i = 0; i < maxInstallments; i++) {
      const borrowerRows: LoanDetailScheduleBorrowerRow[] = [];
      let dueDate: Date | null = null;
      let principalKobo = 0;
      let interestKobo = 0;
      let totalDueKobo = 0;
      let amountPaidKobo = 0;

      for (const account of accounts) {
        const entry = account.schedule[i];
        if (!entry) continue;
        dueDate = entry.dueDate;
        principalKobo += entry.principalPortion;
        interestKobo += entry.interestPortion;
        totalDueKobo += entry.totalDue;

        // FIFO: consume this member's own approved repayments, oldest first,
        // against their own schedule rows in installment order.
        const accountRepayments = repaymentsByAccount.get(account._id.toString()) ?? [];
        let alreadyAllocated = 0;
        for (let j = 0; j < i; j++) {
          alreadyAllocated += account.schedule[j]?.totalDue ?? 0;
        }
        const totalPaidForAccount = accountRepayments.reduce((sum, r) => sum + r.amountKobo, 0);
        const paidForThisRow = Math.max(
          0,
          Math.min(entry.totalDue, totalPaidForAccount - alreadyAllocated),
        );
        amountPaidKobo += paidForThisRow;

        const customer = customerById.get(account.customerId.toString());
        borrowerRows.push({
          customerId: account.customerId.toString(),
          name: customer ? `${customer.firstName} ${customer.lastName}`.trim() : account.customerId.toString(),
          principalKobo: entry.principalPortion,
          interestKobo: entry.interestPortion,
          totalDueKobo: entry.totalDue,
          amountPaidKobo: paidForThisRow,
          balanceKobo: entry.totalDue - paidForThisRow,
          status: paidForThisRow >= entry.totalDue ? 'PAID' : paidForThisRow > 0 ? 'PARTIAL' : 'PENDING',
        });
      }

      rows.push({
        installmentNumber: i + 1,
        dueDate: dueDate ?? new Date(0),
        principalKobo,
        interestKobo,
        totalDueKobo,
        amountPaidKobo,
        balanceKobo: totalDueKobo - amountPaidKobo,
        status: amountPaidKobo >= totalDueKobo ? 'PAID' : amountPaidKobo > 0 ? 'PARTIAL' : 'PENDING',
        borrowerRows,
      });
    }

    return rows;
  }

  /** Real audit trail for this loan, plus every DisbursementVerification/MemberLoanAccount action tied to its own members — resolved through AuditService (LoansService/LoanVerificationService already record these). */
  private async buildActivity(
    loanId: string,
    staffNamesById: Map<string, string>,
  ): Promise<LoanDetailActivityEntry[]> {
    const entries = await this.loansService.getAuditTrailForLoan(loanId);
    return entries.map((entry) => ({
      action: entry.action,
      date: entry.timestamp,
      byName: entry.actorId ? (staffNamesById.get(entry.actorId) ?? entry.actorId) : 'System',
    }));
  }
}
