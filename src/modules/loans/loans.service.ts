import {
  BadRequestException,
  ConflictException,
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
  MemberLoanAccountStatus,
} from '../../common/enums/loan.enums';
import { WorkflowEntityType } from '../../common/enums/workflow.enums';
import { AuditService } from '../../platform/audit/audit.service';
import {
  WORKFLOW_APPROVED_EVENT,
  WORKFLOW_REJECTED_EVENT,
  WorkflowApprovedEvent,
  WorkflowRejectedEvent,
} from '../../platform/workflow-engine/events/workflow-engine.events';
import { WorkflowRequestDocument } from '../../platform/workflow-engine/schemas/workflow-request.schema';
import { WorkflowEngineService } from '../../platform/workflow-engine/workflow-engine.service';
import { GroupsService } from '../groups/groups.service';
import {
  LOAN_APPROVAL_ACTION_PREFIX,
  loanApprovalActionFor,
} from '../loan-products/loan-products.service';
import { FeeDefinitionsService } from '../loan-products/fee-definitions.service';
import { LoanProductsService } from '../loan-products/loan-products.service';
import { FeePaymentsService, OutstandingPreLoanFee } from './fee-payments.service';
import { NOTIFICATION_PORT, NotificationPort } from './interfaces/notification-port.interface';
import { MemberLoanAccount, MemberLoanAccountDocument } from './schemas/member-loan-account.schema';
import { Loan, LoanDocument } from './schemas/loan.schema';

export interface RaiseApplicationMemberRequest {
  customerId: string;
  requestedAmountKobo: number;
  disbursementChannel: DisbursementChannel;
}

export interface MemberOutstandingPreLoanFees {
  customerId: string;
  fees: OutstandingPreLoanFee[];
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

@Injectable()
export class LoansService {
  constructor(
    @InjectModel(Loan.name) private readonly loanModel: Model<LoanDocument>,
    @InjectModel(MemberLoanAccount.name)
    private readonly memberLoanAccountModel: Model<MemberLoanAccountDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly groupsService: GroupsService,
    private readonly loanProductsService: LoanProductsService,
    private readonly feeDefinitionsService: FeeDefinitionsService,
    private readonly feePaymentsService: FeePaymentsService,
    private readonly workflowEngineService: WorkflowEngineService,
    private readonly auditService: AuditService,
    @Inject(NOTIFICATION_PORT) private readonly notificationPort: NotificationPort,
  ) {}

  // ---------------------------------------------------------------------------
  // Raising an application
  // ---------------------------------------------------------------------------

  async raiseApplication(
    groupId: string,
    productId: string,
    tenureMonths: number,
    memberLoanRequests: RaiseApplicationMemberRequest[],
    raisedBy: string,
  ): Promise<RaiseApplicationResult> {
    const group = await this.groupsService.findById(groupId);

    const eligibility = await this.groupsService.isEligibleForLoanApplication(groupId);
    if (!eligibility.eligible) {
      throw new ConflictException({
        message: `Group ${groupId} is not eligible for a loan application`,
        ineligibleMembers: eligibility.ineligibleMembers,
      });
    }

    const product = await this.loanProductsService.findByIdOrThrow(productId);
    if (!product.tenureOptions.includes(tenureMonths)) {
      throw new BadRequestException(
        `tenureMonths ${tenureMonths} is not one of this product's tenureOptions: ${product.tenureOptions.join(', ')}`,
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

    const cumulativeAmountKobo = memberLoanRequests.reduce(
      (sum, r) => sum + r.requestedAmountKobo,
      0,
    );

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
              tenureMonths,
              cumulativeAmountKobo,
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
    // exists, not once approved. Both the per-member amount and the group
    // cumulative amount are included: the brief's "amount and date" wording
    // doesn't say which figure it means, so both are sent rather than
    // guessing. See PHASE_8_NOTES.md.
    for (const request of memberLoanRequests) {
      await this.notificationPort.sendLoanRaisedNotification(
        request.customerId,
        request.requestedAmountKobo,
        cumulativeAmountKobo,
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
        tenureMonths,
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
      after: { groupId, productId, tenureMonths, cumulativeAmountKobo },
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

  async getMemberLoanAccounts(loanId: string): Promise<MemberLoanAccountDocument[]> {
    return this.memberLoanAccountModel.find({ loanId: new Types.ObjectId(loanId) }).exec();
  }
}
