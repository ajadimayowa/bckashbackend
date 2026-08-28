import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';

import {
  DisbursementChannel,
  LoanStatus,
  MEMBER_LOAN_ACCOUNT_STATUSES_BLOCKING_REMOVAL,
  MemberLoanAccountStatus,
} from '../../common/enums/loan.enums';
import { StaffRole } from '../../common/enums/identity.enums';
import { InterestType } from '../../common/enums/loan-product.enums';
import { WorkflowEntityType, WorkflowStatus } from '../../common/enums/workflow.enums';
import { AuditService } from '../../platform/audit/audit.service';
import { AuditLogDocument } from '../../platform/audit/schemas/audit-log.schema';
import {
  WORKFLOW_APPROVED_EVENT,
  WORKFLOW_REJECTED_EVENT,
  WorkflowApprovedEvent,
  WorkflowRejectedEvent,
} from '../../platform/workflow-engine/events/workflow-engine.events';
import { WorkflowRequestDocument } from '../../platform/workflow-engine/schemas/workflow-request.schema';
import { WorkflowEngineService } from '../../platform/workflow-engine/workflow-engine.service';
import {
  S3_ADAPTER,
  S3Adapter,
} from '../../platform/integrations/s3/interfaces/s3-adapter.interface';
import { buildLoanApplicantPhotoObjectKey } from '../../platform/integrations/s3/s3-key.util';
import { BranchFundBalanceService } from '../branches/branch-fund-balance.service';
// Cross-module raw model read only, same pattern as fee-payments.service.ts/
// loan-consent.service.ts in this very module — resolving a member's
// display name for the Loans Directory list doesn't need the whole
// CustomersModule.
import { Customer, CustomerDocument } from '../customers/schemas/customer.schema';
import { GroupsService } from '../groups/groups.service';
import {
  calculateFlatInterestSchedule,
  calculateReducingBalanceSchedule,
} from '../loan-products/calculations';
import {
  LOAN_APPROVAL_ACTION_PREFIX,
  loanApprovalActionFor,
} from '../loan-products/loan-products.service';
import { FeeDefinitionsService } from '../loan-products/fee-definitions.service';
import { LoanProductsService } from '../loan-products/loan-products.service';
import { FeePaymentsService, OutstandingPreLoanFee } from './fee-payments.service';
import { NOTIFICATION_PORT, NotificationPort } from './interfaces/notification-port.interface';
import { LoanConsentService } from './loan-consent.service';
import {
  BankAccountDetails,
  MemberLoanAccount,
  MemberLoanAccountDocument,
} from './schemas/member-loan-account.schema';
import { Loan, LoanDocument } from './schemas/loan.schema';

export interface RaiseApplicationMemberRequest {
  customerId: string;
  requestedAmountKobo: number;
  disbursementChannel: DisbursementChannel;
  /** Required iff disbursementChannel is TRANSFER — re-checked here, not just at the DTO layer. */
  bankAccountDetails?: BankAccountDetails;
}

export interface MemberOutstandingPreLoanFees {
  customerId: string;
  fees: OutstandingPreLoanFee[];
}

/** One customer's slice of one loan, enriched with the parent Loan's and LoanProduct's
 * read-only fields — the flat shape CustomerDetail.tsx's "Loan History" tab reads. */
export interface CustomerLoanHistoryItem {
  memberLoanAccountId: string;
  loanId: string;
  status: MemberLoanAccountStatus;
  loanStatus: LoanStatus | null;
  principalAmountKobo: number;
  disbursementChannel: DisbursementChannel;
  outstandingBalanceKobo: number | null;
  productId: string | null;
  productName: string | null;
  interestRateBasisPoints: number | null;
  tenureDays: number | null;
  raisedAt: Date | null;
  approvedAt: Date | null;
  disbursedAt: Date | null;
  /** Due date of the last schedule installment, once disbursed — null before then. */
  maturityDate: Date | null;
}

/**
 * Widened return type — see PHASE_8_NOTES.md. The brief's literal signature
 * for `raiseApplication` returns `Promise<Loan>`, but it also requires
 * surfacing (never blocking on) outstanding PRE_LOAN fees, and a caller
 * reasonably wants the created MemberLoanAccounts + WorkflowRequest back too
 * rather than re-querying immediately after. Same "deliberate, documented
 * widening" precedent as Phase 6's `IneligibleMember.customerId`.
 */
export interface RaiseApplicationResult {
  loan: LoanDocument;
  memberLoanAccounts: MemberLoanAccountDocument[];
  workflowRequest: WorkflowRequestDocument;
  outstandingPreLoanFees: MemberOutstandingPreLoanFees[];
}

/** Same shape as GroupsService's GroupViewerContext — deliberately not
 * shared/imported across modules for this since it's a tiny structural type. */
export interface LoanViewerContext {
  staffId: string;
  role: StaffRole;
  branchId?: string;
}

export interface FindLoansFilter {
  branchId?: string;
  groupId?: string;
  status?: LoanStatus;
  /**
   * Only meaningful for ADMIN/SUPERADMIN/APPROVER — MANAGER is already
   * branch-locked and MARKETER is already forced to their own raisedBy (see
   * listForActor), so this is silently ignored for those two roles rather
   * than erroring, same treatment as branchId already gets.
   */
  raisedBy?: string;
}

/** One row for the "Group Loans Directory" list — enough to render the
 * whole table without a follow-up request per loan. */
export interface LoanSummary {
  id: string;
  groupId: string;
  groupName: string;
  branchId: string;
  branchName: string | null;
  productId: string;
  productName: string | null;
  memberCount: number;
  /** Every member's own name, in the same order as the underlying member accounts — usually just one, since this app only ever raises a loan for a single customer at a time even though the schema allows more. */
  memberCustomerNames: string[];
  cumulativeAmountKobo: number;
  /** Sum of every member account's outstandingBalanceKobo — 0 before disbursement (schedules don't exist yet). */
  outstandingBalanceKobo: number;
  /**
   * Sum of every member's own interest — the *real*, schedule-derived figure
   * once disbursed (LoanVerificationService.disburse persists `schedule` at
   * that point), estimated the same way beforehand (same
   * calculateFlatInterestSchedule/calculateReducingBalanceSchedule the real
   * disbursement schedule itself is built from, applied to each member's own
   * `principalAmountKobo` — not a rough guess, just not-yet-final since the
   * balance/product could still change before disbursement). See
   * `interestIsEstimate` for which one a given row is showing.
   */
  totalInterestKobo: number;
  /** cumulativeAmountKobo + totalInterestKobo — what members owe in total across every installment. */
  totalRepayableKobo: number;
  /** true until the loan is actually DISBURSED — see totalInterestKobo's own doc comment. */
  interestIsEstimate: boolean;
  status: LoanStatus;
  raisedAt: Date;
  approvedAt: Date | null;
  disbursedAt: Date | null;
}

@Injectable()
export class LoansService {
  constructor(
    @InjectModel(Loan.name) private readonly loanModel: Model<LoanDocument>,
    @InjectModel(MemberLoanAccount.name)
    private readonly memberLoanAccountModel: Model<MemberLoanAccountDocument>,
    @InjectModel(Customer.name) private readonly customerModel: Model<CustomerDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly groupsService: GroupsService,
    private readonly loanProductsService: LoanProductsService,
    private readonly feeDefinitionsService: FeeDefinitionsService,
    private readonly feePaymentsService: FeePaymentsService,
    private readonly workflowEngineService: WorkflowEngineService,
    private readonly auditService: AuditService,
    @Inject(NOTIFICATION_PORT) private readonly notificationPort: NotificationPort,
    private readonly loanConsentService: LoanConsentService,
    @Inject(S3_ADAPTER) private readonly s3Adapter: S3Adapter,
    private readonly branchFundBalanceService: BranchFundBalanceService,
  ) {}

  // ---------------------------------------------------------------------------
  // Raising an application
  // ---------------------------------------------------------------------------

  async raiseApplication(
    groupId: string,
    productId: string,
    tenureDays: number,
    memberLoanRequests: RaiseApplicationMemberRequest[],
    raisedBy: string,
    consentChallengeId: string,
    consentCode: string,
    purpose?: string,
  ): Promise<RaiseApplicationResult> {
    // Verified before anything else — see LoanConsentService's own comment.
    // The consenting customer must actually be one of the members this
    // application is for, not just some other customer's code.
    const consentedCustomerId = await this.loanConsentService.verifyChallenge(
      consentChallengeId,
      consentCode,
    );
    if (!memberLoanRequests.some((r) => r.customerId === consentedCustomerId)) {
      throw new BadRequestException(
        'The consent code was not issued for any customer in this application',
      );
    }

    for (const request of memberLoanRequests) {
      if (
        request.disbursementChannel === DisbursementChannel.TRANSFER &&
        !request.bankAccountDetails
      ) {
        throw new BadRequestException(
          `bankAccountDetails is required for customer ${request.customerId} — disbursementChannel is TRANSFER`,
        );
      }
    }

    const group = await this.groupsService.findById(groupId);

    const eligibility = await this.groupsService.isEligibleForLoanApplication(groupId);
    if (!eligibility.eligible) {
      throw new ConflictException({
        message: `Group ${groupId} is not eligible for a loan application`,
        ineligibleMembers: eligibility.ineligibleMembers,
      });
    }

    const product = await this.loanProductsService.findByIdOrThrow(productId);
    if (!product.tenureOptions.includes(tenureDays)) {
      throw new BadRequestException(
        `tenureDays ${tenureDays} is not one of this product's tenureOptions: ${product.tenureOptions.join(', ')}`,
      );
    }

    const activeMembers = await this.groupsService.getActiveMembers(groupId);
    if (activeMembers.length < product.minGroupSize) {
      throw new ConflictException(
        `Group ${groupId} has ${activeMembers.length} active member(s), below this product's minGroupSize of ${product.minGroupSize}`,
      );
    }
    const activeMemberIds = new Set(activeMembers.map((m) => m.customerId.toString()));

    if (memberLoanRequests.length === 0) {
      throw new BadRequestException('memberLoanRequests must not be empty');
    }
    const requestedCustomerIds = new Set<string>();
    for (const request of memberLoanRequests) {
      if (!activeMemberIds.has(request.customerId)) {
        throw new BadRequestException(
          `Customer ${request.customerId} is not an active member of group ${groupId}`,
        );
      }
      if (requestedCustomerIds.has(request.customerId)) {
        throw new BadRequestException(
          `Customer ${request.customerId} appears more than once in memberLoanRequests`,
        );
      }
      requestedCustomerIds.add(request.customerId);
      if (!Number.isInteger(request.requestedAmountKobo) || request.requestedAmountKobo <= 0) {
        throw new BadRequestException(
          `requestedAmountKobo for customer ${request.customerId} must be a positive integer`,
        );
      }
    }

    // A customer must fully resolve one loan (rejected, or repaid/closed)
    // before another can be raised for them — same PENDING/ACTIVE-blocks
    // rule GroupsService already enforces for membership removal (see
    // MEMBER_LOAN_ACCOUNT_STATUSES_BLOCKING_REMOVAL's own doc comment).
    const existingPendingAccounts = await this.memberLoanAccountModel
      .find({
        customerId: { $in: memberLoanRequests.map((r) => new Types.ObjectId(r.customerId)) },
        status: { $in: MEMBER_LOAN_ACCOUNT_STATUSES_BLOCKING_REMOVAL },
      })
      .exec();
    if (existingPendingAccounts.length > 0) {
      const blockedCustomerIds = [
        ...new Set(existingPendingAccounts.map((a) => a.customerId.toString())),
      ];
      throw new ConflictException(
        `Customer(s) ${blockedCustomerIds.join(', ')} already have a loan that hasn't been closed (rejected or fully repaid) yet — only one loan at a time per customer`,
      );
    }

    const cumulativeAmountKobo = memberLoanRequests.reduce(
      (sum, r) => sum + r.requestedAmountKobo,
      0,
    );

    // The branch must actually be able to cover this loan before it's even
    // raised — not just at disbursement time (BranchFundBalanceService.debit
    // still guards that separately, atomically, since the balance can move
    // between now and approval/disbursement). Checked here so a marketer
    // gets clear, immediate feedback instead of an application that sails
    // through review only to stall at disbursement.
    const availableBranchBalanceKobo = await this.branchFundBalanceService.getBalance(
      group.branchId.toString(),
    );
    if (availableBranchBalanceKobo < cumulativeAmountKobo) {
      throw new ConflictException(
        `Branch ${group.branchId.toString()} has insufficient funds for this loan — available: ${availableBranchBalanceKobo} kobo, requested: ${cumulativeAmountKobo} kobo`,
      );
    }

    const feeDefinitions = await Promise.all(
      product.feeIds.map((id) => this.feeDefinitionsService.findByIdOrThrow(id.toString())),
    );
    const outstandingPreLoanFees: MemberOutstandingPreLoanFees[] = [];
    for (const request of memberLoanRequests) {
      const fees = await this.feePaymentsService.getOutstandingPreLoanFees(
        request.customerId,
        productId,
        feeDefinitions,
        request.requestedAmountKobo,
      );
      if (fees.length > 0) {
        outstandingPreLoanFees.push({ customerId: request.customerId, fees });
      }
    }

    const now = new Date();
    const session = await this.connection.startSession();
    let loan: LoanDocument | null = null;
    let memberLoanAccounts: MemberLoanAccountDocument[] = [];

    try {
      await session.withTransaction(async () => {
        const createdLoans = await this.loanModel.create(
          [
            {
              groupId: new Types.ObjectId(groupId),
              productId: new Types.ObjectId(productId),
              branchId: group.branchId,
              tenureDays,
              cumulativeAmountKobo,
              purpose: purpose?.trim() || null,
              status: LoanStatus.PENDING_APPROVAL,
              raisedBy: new Types.ObjectId(raisedBy),
              raisedAt: now,
            },
          ],
          { session, ordered: true },
        );
        const createdLoan = createdLoans[0];
        if (!createdLoan) {
          throw new Error('loanModel.create([...]) returned an empty array');
        }
        loan = createdLoan;

        memberLoanAccounts = await this.memberLoanAccountModel.create(
          memberLoanRequests.map((request) => ({
            loanId: createdLoan._id,
            customerId: new Types.ObjectId(request.customerId),
            principalAmountKobo: request.requestedAmountKobo,
            disbursementChannel: request.disbursementChannel,
            bankAccountDetails: request.bankAccountDetails ?? null,
            schedule: [],
            outstandingBalanceKobo: null,
            status: MemberLoanAccountStatus.PENDING,
          })),
          { session, ordered: true },
        );
      });
    } finally {
      await session.endSession();
    }

    if (!loan) {
      throw new Error(`raiseApplication transaction for group ${groupId} completed without a loan`);
    }
    const createdLoan = loan as LoanDocument;

    // Immediately, before the workflow request even exists — the brief
    // requires the "loan raised" notification to fire as soon as the loan
    // exists, not once approved. Only each member's own requested amount is
    // sent — never the group's cumulative amount, which would expose what
    // every other member individually borrowed to a customer who has no
    // right to see it. See PHASE_8_NOTES.md.
    for (const request of memberLoanRequests) {
      await this.notificationPort.sendLoanRaisedNotification(
        request.customerId,
        request.requestedAmountKobo,
        now,
      );
    }

    const workflowRequest = await this.workflowEngineService.initiate({
      entityType: WorkflowEntityType.LOAN,
      action: loanApprovalActionFor(productId),
      payload: {
        loanId: createdLoan._id.toString(),
        groupId,
        productId,
        tenureDays,
        cumulativeAmountKobo,
      },
      initiatedBy: raisedBy,
      branchId: group.branchId.toString(),
      // The loan already exists (see Loan schema's own doc comment) — hand its
      // id over at initiation rather than the usual post-approval linkEntity.
      entityId: createdLoan._id.toString(),
    });

    await this.auditService.record({
      actorId: raisedBy,
      action: 'LOAN_RAISED',
      entityType: 'LOAN',
      entityId: createdLoan._id.toString(),
      after: { groupId, productId, tenureDays, cumulativeAmountKobo },
      metadata: { workflowRequestId: workflowRequest._id.toString() },
    });

    return { loan: createdLoan, memberLoanAccounts, workflowRequest, outstandingPreLoanFees };
  }

  // ---------------------------------------------------------------------------
  // Workflow event dispatch
  // ---------------------------------------------------------------------------

  @OnEvent(WORKFLOW_APPROVED_EVENT)
  async handleWorkflowApproved(event: WorkflowApprovedEvent): Promise<void> {
    if (!this.isLoanApprovalEvent(event)) {
      return;
    }

    const updated = await this.loanModel
      .findOneAndUpdate(
        { _id: event.entityId, status: LoanStatus.PENDING_APPROVAL },
        { $set: { status: LoanStatus.APPROVED, approvedAt: new Date() } },
        { new: true },
      )
      .exec();
    if (!updated) {
      // Not necessarily an error — e.g. a duplicate event delivery. Nothing
      // to update if it's already past PENDING_APPROVAL.
      return;
    }

    // Every member on this loan gets told individually — same "call to fix
    // a date for verification" prompt for each, since disbursement
    // verification (LoanVerificationService) is itself done per-borrower.
    const accounts = await this.getMemberLoanAccounts(updated._id.toString());
    for (const account of accounts) {
      await this.notificationPort.sendLoanApprovedNotification(
        account.customerId.toString(),
        updated.approvedAt!,
      );
    }

    await this.auditService.record({
      actorId: event.initiatedBy,
      action: 'LOAN_APPROVED',
      entityType: 'LOAN',
      entityId: updated._id.toString(),
      after: { status: LoanStatus.APPROVED },
      metadata: { workflowRequestId: event.workflowRequestId },
    });
  }

  @OnEvent(WORKFLOW_REJECTED_EVENT)
  async handleWorkflowRejected(event: WorkflowRejectedEvent): Promise<void> {
    if (!this.isLoanApprovalEvent(event) || !event.entityId) {
      return;
    }

    await this.rejectLoan(event.entityId, event.comment ?? 'Rejected by workflow approval chain');

    await this.auditService.record({
      actorId: event.rejectedBy,
      action: 'LOAN_REJECTED',
      entityType: 'LOAN',
      entityId: event.entityId,
      after: { status: LoanStatus.REJECTED },
      metadata: { workflowRequestId: event.workflowRequestId, comment: event.comment ?? null },
    });
  }

  private isLoanApprovalEvent(event: {
    entityType: string;
    action: string;
    entityId: string | null;
  }): boolean {
    return (
      (event.entityType as WorkflowEntityType) === WorkflowEntityType.LOAN &&
      event.action.startsWith(LOAN_APPROVAL_ACTION_PREFIX) &&
      Boolean(event.entityId)
    );
  }

  /**
   * Rejects a loan and closes every one of its MemberLoanAccounts — WITHOUT
   * ever having activated them. Shared by the workflow-rejection handler above
   * and `LoanVerificationService.resolveEscalation`'s REJECT_LOAN path. Every
   * MemberLoanAccount is still PENDING at this point by construction — the
   * all-or-nothing disbursement design (see PHASE_8_NOTES.md) means an
   * account can only reach ACTIVE once every member has passed verification,
   * so a rejection (whether at the approval-chain stage or the verification
   * stage) can never happen after any account has already gone ACTIVE.
   * CLOSED, not DEFAULTED — this loan was never disbursed, it simply isn't
   * proceeding.
   */
  async rejectLoan(loanId: string, _reason: string): Promise<LoanDocument> {
    const updated = await this.loanModel
      .findOneAndUpdate({ _id: loanId }, { $set: { status: LoanStatus.REJECTED } }, { new: true })
      .exec();
    if (!updated) {
      throw new NotFoundException(`Loan ${loanId} not found`);
    }

    await this.memberLoanAccountModel
      .updateMany(
        { loanId: new Types.ObjectId(loanId) },
        { $set: { status: MemberLoanAccountStatus.CLOSED } },
      )
      .exec();

    return updated;
  }

  /**
   * Recomputes whether this Loan should be CLOSED ("Completed" in the UI —
   * see LoanDetail.tsx's own loanStatusBadge) based on whether every one of
   * its MemberLoanAccounts has itself reached CLOSED. A MemberLoanAccount
   * only ever reaches CLOSED once its own outstandingBalanceKobo hits
   * exactly 0 (RepaymentsService.applyToBalance) or is force-zeroed by an
   * early liquidation payoff (EarlyLiquidationService.checkCompletion) —
   * either way that balance already has every penalty ever charged against
   * it baked in (PenaltySweepService increments the same
   * outstandingBalanceKobo a repayment decrements), so there's nothing extra
   * to factor in here.
   *
   * Symmetric: also reopens (back to DISBURSED) a Loan that was marked
   * CLOSED if a dispute reversal (RepaymentsService.reverseBalance) later
   * reopened one of its accounts again — the natural counterpart of the
   * close side, same "reversal undoes the side effect" reasoning
   * `reverseBalance` itself already documents for the account-level status.
   *
   * No-op for a loan that was never disbursed (nothing to close) or is
   * already in the right state. Safe to call after every event that can
   * change a MemberLoanAccount's CLOSED-ness — every call site is a fire-
   * and-forget "resync", not a state transition this method owns alone.
   */
  async syncCompletionStatus(loanId: string): Promise<void> {
    const loan = await this.loanModel.findById(loanId).exec();
    if (!loan || (loan.status !== LoanStatus.DISBURSED && loan.status !== LoanStatus.CLOSED)) {
      return;
    }

    const accounts = await this.memberLoanAccountModel
      .find({ loanId: new Types.ObjectId(loanId) })
      .exec();
    const allSettled =
      accounts.length > 0 && accounts.every((a) => a.status === MemberLoanAccountStatus.CLOSED);

    if (allSettled && loan.status !== LoanStatus.CLOSED) {
      await this.loanModel.updateOne({ _id: loanId }, { $set: { status: LoanStatus.CLOSED } }).exec();
    } else if (!allSettled && loan.status === LoanStatus.CLOSED) {
      await this.loanModel
        .updateOne({ _id: loanId }, { $set: { status: LoanStatus.DISBURSED } })
        .exec();
    }
  }

  // ---------------------------------------------------------------------------
  // Editing / deleting a still-pending application — raiser only, and only
  // while PENDING_APPROVAL: once any step of the approval chain has acted
  // (or the loan has moved past it), the application is locked. Mirrors
  // CustomerService.deleteCustomer's own precedent exactly (cancel whatever
  // WorkflowRequest is still active, then hard-delete).
  // ---------------------------------------------------------------------------

  private assertIsRaiser(loan: LoanDocument, actorId: string): void {
    if (loan.raisedBy.toString() !== actorId) {
      throw new ForbiddenException('Only the staff member who raised this loan may act on it');
    }
  }

  private assertStillPending(loan: LoanDocument): void {
    if (loan.status !== LoanStatus.PENDING_APPROVAL) {
      throw new ConflictException(
        `Loan ${loan._id.toString()} has already progressed past PENDING_APPROVAL (status: ${loan.status}) and can no longer be edited or deleted`,
      );
    }
  }

  /**
   * Tenure/purpose apply to the whole Loan; each `memberLoanRequests` entry
   * (matched by `customerId`) updates that member's own MemberLoanAccount —
   * this never adds or removes a member, only corrects what was already
   * raised for one. `cumulativeAmountKobo` is always re-derived from the
   * accounts' current principal after applying changes, never taken as
   * given, so it can't drift out of sync.
   */
  async updatePendingApplication(
    loanId: string,
    actorId: string,
    changes: {
      tenureDays?: number;
      purpose?: string;
      memberLoanRequests?: RaiseApplicationMemberRequest[];
    },
  ): Promise<{ loan: LoanDocument; memberLoanAccounts: MemberLoanAccountDocument[] }> {
    const loan = await this.findByIdOrThrow(loanId);
    this.assertIsRaiser(loan, actorId);
    this.assertStillPending(loan);

    if (changes.tenureDays !== undefined) {
      const product = await this.loanProductsService.findByIdOrThrow(loan.productId.toString());
      if (!product.tenureOptions.includes(changes.tenureDays)) {
        throw new BadRequestException(
          `tenureDays ${changes.tenureDays} is not one of this product's tenureOptions: ${product.tenureOptions.join(', ')}`,
        );
      }
      loan.tenureDays = changes.tenureDays;
    }
    if (changes.purpose !== undefined) {
      loan.purpose = changes.purpose.trim() || null;
    }

    let accounts = await this.getMemberLoanAccounts(loanId);

    if (changes.memberLoanRequests !== undefined) {
      const accountByCustomerId = new Map(accounts.map((a) => [a.customerId.toString(), a]));
      for (const request of changes.memberLoanRequests) {
        const account = accountByCustomerId.get(request.customerId);
        if (!account) {
          throw new BadRequestException(
            `Customer ${request.customerId} is not a member on loan ${loanId} — editing can't add or remove members`,
          );
        }
        if (!Number.isInteger(request.requestedAmountKobo) || request.requestedAmountKobo <= 0) {
          throw new BadRequestException(
            `requestedAmountKobo for customer ${request.customerId} must be a positive integer`,
          );
        }
        if (request.disbursementChannel === DisbursementChannel.TRANSFER && !request.bankAccountDetails) {
          throw new BadRequestException(
            `bankAccountDetails is required for customer ${request.customerId} — disbursementChannel is TRANSFER`,
          );
        }
        account.principalAmountKobo = request.requestedAmountKobo;
        account.disbursementChannel = request.disbursementChannel;
        account.bankAccountDetails =
          request.disbursementChannel === DisbursementChannel.TRANSFER
            ? (request.bankAccountDetails ?? null)
            : null;
        await account.save();
      }
      accounts = await this.getMemberLoanAccounts(loanId);
    }

    loan.cumulativeAmountKobo = accounts.reduce((sum, a) => sum + a.principalAmountKobo, 0);
    await loan.save();

    await this.auditService.record({
      actorId,
      action: 'LOAN_UPDATED',
      entityType: 'LOAN',
      entityId: loanId,
      after: { tenureDays: loan.tenureDays, purpose: loan.purpose, cumulativeAmountKobo: loan.cumulativeAmountKobo },
    });

    return { loan, memberLoanAccounts: accounts };
  }

  async deleteLoan(loanId: string, actorId: string): Promise<void> {
    const loan = await this.findByIdOrThrow(loanId);
    this.assertIsRaiser(loan, actorId);
    this.assertStillPending(loan);

    const history = await this.workflowEngineService.getHistory(WorkflowEntityType.LOAN, loanId);
    const activeRequest = history.find(
      (request) =>
        request.status === WorkflowStatus.PENDING_REVIEW ||
        request.status === WorkflowStatus.PENDING_APPROVAL ||
        request.status === WorkflowStatus.RETURNED_TO_MAKER,
    );
    if (activeRequest) {
      await this.workflowEngineService.cancel({
        workflowRequestId: activeRequest._id.toString(),
        actorId,
      });
    }

    await this.memberLoanAccountModel.deleteMany({ loanId: new Types.ObjectId(loanId) }).exec();
    await this.loanModel.deleteOne({ _id: loanId }).exec();

    await this.auditService.record({
      actorId,
      action: 'LOAN_DELETED',
      entityType: 'LOAN',
      entityId: loanId,
      before: { status: loan.status, cumulativeAmountKobo: loan.cumulativeAmountKobo },
    });
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  async findByIdOrThrow(loanId: string): Promise<LoanDocument> {
    const loan = await this.loanModel.findById(loanId).exec();
    if (!loan) {
      throw new NotFoundException(`Loan ${loanId} not found`);
    }
    return loan;
  }

  /**
   * Row-level scoping mirrors GroupsService.findAllForActor exactly (see
   * that method's own doc comment): ADMIN/SUPERADMIN/APPROVER see every
   * loan (optionally narrowed by `filter.branchId`/`filter.groupId`); a
   * MANAGER only ever sees their own branch's loans; anyone else
   * (MARKETER) only sees loans they themselves raised.
   */
  async listForActor(filter: FindLoansFilter, viewer: LoanViewerContext): Promise<LoanSummary[]> {
    const query: Record<string, unknown> = {};

    if (viewer.role === StaffRole.MANAGER) {
      if (!viewer.branchId) {
        return [];
      }
      query.branchId = new Types.ObjectId(viewer.branchId);
    } else if (
      viewer.role !== StaffRole.ADMIN &&
      viewer.role !== StaffRole.SUPERADMIN &&
      viewer.role !== StaffRole.APPROVER
    ) {
      query.raisedBy = new Types.ObjectId(viewer.staffId);
    } else {
      if (filter.branchId) {
        query.branchId = new Types.ObjectId(filter.branchId);
      }
      if (filter.raisedBy) {
        query.raisedBy = new Types.ObjectId(filter.raisedBy);
      }
    }

    if (filter.groupId) {
      query.groupId = new Types.ObjectId(filter.groupId);
    }
    if (filter.status) {
      query.status = filter.status;
    }

    const loans = await this.loanModel.find(query).sort({ raisedAt: -1 }).exec();
    if (loans.length === 0) {
      return [];
    }

    const groupIds = [...new Set(loans.map((loan) => loan.groupId.toString()))];
    const groups = await Promise.all(
      groupIds.map((id) => this.groupsService.findById(id).catch(() => null)),
    );
    const groupById = new Map(
      groups
        .filter((group): group is NonNullable<typeof group> => group !== null)
        .map((group) => [group._id.toString(), group]),
    );

    const productIds = [...new Set(loans.map((loan) => loan.productId.toString()))];
    const products = await Promise.all(
      productIds.map((id) => this.loanProductsService.findByIdOrThrow(id).catch(() => null)),
    );
    const productById = new Map(
      products
        .filter((product): product is NonNullable<typeof product> => product !== null)
        .map((product) => [product._id.toString(), product]),
    );

    const loanIds = loans.map((loan) => loan._id);
    const accounts = await this.memberLoanAccountModel.find({ loanId: { $in: loanIds } }).exec();
    const accountsByLoan = new Map<string, MemberLoanAccountDocument[]>();
    for (const account of accounts) {
      const key = account.loanId.toString();
      const list = accountsByLoan.get(key) ?? [];
      list.push(account);
      accountsByLoan.set(key, list);
    }

    const branchNamesById = await this.groupsService.resolveBranchNames(
      [...new Set(loans.map((loan) => loan.branchId.toString()))],
    );

    const customerIds = [...new Set(accounts.map((account) => account.customerId.toString()))];
    const customers =
      customerIds.length > 0
        ? await this.customerModel
            .find({ _id: { $in: customerIds } })
            .select('firstName lastName')
            .exec()
        : [];
    const customerNameById = new Map(
      customers.map((customer) => [customer._id.toString(), `${customer.firstName} ${customer.lastName}`.trim()]),
    );

    return loans.map((loan): LoanSummary => {
      const group = groupById.get(loan.groupId.toString()) ?? null;
      const product = productById.get(loan.productId.toString()) ?? null;
      const loanAccounts = accountsByLoan.get(loan._id.toString()) ?? [];
      const outstandingBalanceKobo = loanAccounts.reduce(
        (sum, account) => sum + (account.outstandingBalanceKobo ?? 0),
        0,
      );

      // One installment per `product.repaymentPeriodDays`-day cycle — same
      // derivation LoanVerificationService.disburse itself uses (see its own
      // comment) — needed here only for the *estimate* below (a
      // not-yet-disbursed account has no `schedule` of its own yet).
      const installmentCount = product
        ? Math.max(1, Math.ceil(loan.tenureDays / product.repaymentPeriodDays))
        : 1;
      const interestIsEstimate = loanAccounts.some((account) => account.schedule.length === 0);
      const totalInterestKobo = loanAccounts.reduce((sum, account) => {
        if (account.schedule.length > 0) {
          return sum + account.schedule.reduce((s, entry) => s + entry.interestPortion, 0);
        }
        if (!product) return sum;
        if (product.interestType === InterestType.FLAT) {
          return (
            sum +
            calculateFlatInterestSchedule(account.principalAmountKobo, product.interestRate, installmentCount)
              .totalInterestKobo
          );
        }
        const reducing = calculateReducingBalanceSchedule(
          account.principalAmountKobo,
          product.interestRate,
          installmentCount,
        );
        return sum + reducing.schedule.reduce((s, entry) => s + entry.interestPortion, 0);
      }, 0);

      return {
        id: loan._id.toString(),
        groupId: loan.groupId.toString(),
        groupName: group?.name ?? '—',
        branchId: loan.branchId.toString(),
        branchName: branchNamesById.get(loan.branchId.toString()) ?? null,
        productId: loan.productId.toString(),
        productName: product?.name ?? null,
        memberCount: loanAccounts.length,
        memberCustomerNames: loanAccounts.map(
          (account) => customerNameById.get(account.customerId.toString()) ?? '—',
        ),
        totalInterestKobo,
        totalRepayableKobo: loan.cumulativeAmountKobo + totalInterestKobo,
        interestIsEstimate,
        cumulativeAmountKobo: loan.cumulativeAmountKobo,
        outstandingBalanceKobo,
        status: loan.status,
        raisedAt: loan.raisedAt,
        approvedAt: loan.approvedAt,
        disbursedAt: loan.disbursedAt,
      };
    });
  }

  async getMemberLoanAccounts(loanId: string): Promise<MemberLoanAccountDocument[]> {
    return this.memberLoanAccountModel.find({ loanId: new Types.ObjectId(loanId) }).exec();
  }

  /** Every audit entry recorded against this loan (LOAN_RAISED/APPROVED/REJECTED/DISBURSED — see this service's own audit calls), oldest first — used by the Loan Manager detail view's activity log. */
  async getAuditTrailForLoan(loanId: string): Promise<AuditLogDocument[]> {
    return this.auditService.findByEntity('LOAN', loanId);
  }

  /**
   * A photo of the customer taken at application time — a separate call
   * from `raiseApplication` (the MemberLoanAccount must exist first to have
   * an id to namespace the S3 key by), not a required part of raising the
   * application itself. No status restriction (unlike Customer KYC capture)
   * — a marketer can (re)attach this any time before disbursement.
   */
  async uploadApplicantPhoto(
    memberLoanAccountId: string,
    imageBuffer: Buffer,
    contentType: string,
  ): Promise<{ applicantPhotoImageKey: string }> {
    const account = await this.memberLoanAccountModel.findById(memberLoanAccountId).exec();
    if (!account) {
      throw new NotFoundException(`MemberLoanAccount ${memberLoanAccountId} not found`);
    }

    const extension = contentType.split('/')[1] ?? 'jpg';
    const key = buildLoanApplicantPhotoObjectKey(memberLoanAccountId, extension);
    await this.s3Adapter.upload(key, imageBuffer, contentType);

    account.applicantPhotoImageKey = key;
    await account.save();

    return { applicantPhotoImageKey: key };
  }

  /** Same view scope as GET /loans/:id/member-accounts — a short-lived signed URL for the applicant photo. */
  async getApplicantPhotoSignedUrl(memberLoanAccountId: string): Promise<{ url: string | null }> {
    const account = await this.memberLoanAccountModel.findById(memberLoanAccountId).exec();
    if (!account) {
      throw new NotFoundException(`MemberLoanAccount ${memberLoanAccountId} not found`);
    }
    if (!account.applicantPhotoImageKey) {
      return { url: null };
    }
    const url = await this.s3Adapter.getSignedReadUrl(account.applicantPhotoImageKey);
    return { url };
  }

  /**
   * A customer's full loan history — every MemberLoanAccount they're party
   * to, enriched with their parent Loan (status/tenure/dates) and
   * LoanProduct (name/interest rate) read-only fields. Batches the Loan and
   * LoanProduct lookups (no N+1) since one customer can easily be a member
   * of several loans across several groups over time.
   */
  async getMemberLoanAccountsForCustomer(customerId: string): Promise<CustomerLoanHistoryItem[]> {
    const accounts = await this.memberLoanAccountModel
      .find({ customerId: new Types.ObjectId(customerId) })
      .sort({ createdAt: -1 })
      .exec();
    if (accounts.length === 0) {
      return [];
    }

    const loanIds = [...new Set(accounts.map((account) => account.loanId.toString()))];
    const loans = await this.loanModel.find({ _id: { $in: loanIds } }).exec();
    const loanById = new Map(loans.map((loan) => [loan._id.toString(), loan]));

    const productIds = [...new Set(loans.map((loan) => loan.productId.toString()))];
    const products = await Promise.all(
      productIds.map((id) => this.loanProductsService.findByIdOrThrow(id).catch(() => null)),
    );
    const productById = new Map(
      products
        .filter((product): product is NonNullable<typeof product> => product !== null)
        .map((product) => [product._id.toString(), product]),
    );

    return accounts.map((account): CustomerLoanHistoryItem => {
      const loan = loanById.get(account.loanId.toString()) ?? null;
      const product = loan ? (productById.get(loan.productId.toString()) ?? null) : null;
      const lastScheduleEntry =
        account.schedule.length > 0 ? account.schedule[account.schedule.length - 1] : null;

      return {
        memberLoanAccountId: account._id.toString(),
        loanId: account.loanId.toString(),
        status: account.status,
        loanStatus: loan?.status ?? null,
        principalAmountKobo: account.principalAmountKobo,
        disbursementChannel: account.disbursementChannel,
        outstandingBalanceKobo: account.outstandingBalanceKobo,
        productId: loan ? loan.productId.toString() : null,
        productName: product?.name ?? null,
        interestRateBasisPoints: product?.interestRate ?? null,
        tenureDays: loan?.tenureDays ?? null,
        raisedAt: loan?.raisedAt ?? null,
        approvedAt: loan?.approvedAt ?? null,
        disbursedAt: loan?.disbursedAt ?? null,
        maturityDate: lastScheduleEntry?.dueDate ?? null,
      };
    });
  }
}
