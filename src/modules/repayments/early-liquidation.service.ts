import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';

import { FeeCategory } from '../../common/enums/loan-product.enums';
import { MemberLoanAccountStatus } from '../../common/enums/loan.enums';
import { EarlyLiquidationStatus, RepaymentStatus } from '../../common/enums/repayment.enums';
import { WorkflowEntityType } from '../../common/enums/workflow.enums';
import { AuditService } from '../../platform/audit/audit.service';
import { approveCapability } from '../../platform/rbac/constants/capabilities';
import {
  WORKFLOW_APPROVED_EVENT,
  WORKFLOW_REJECTED_EVENT,
  WorkflowApprovedEvent,
  WorkflowRejectedEvent,
} from '../../platform/workflow-engine/events/workflow-engine.events';
import { WorkflowRequestDocument } from '../../platform/workflow-engine/schemas/workflow-request.schema';
import { WorkflowEngineService } from '../../platform/workflow-engine/workflow-engine.service';
import { calculateEarlyLiquidationFee } from '../loan-products/calculations';
import { FeeDefinitionsService } from '../loan-products/fee-definitions.service';
import { LoanProductsService } from '../loan-products/loan-products.service';
import { FeeDefinitionDocument } from '../loan-products/schemas/fee-definition.schema';
import {
  MemberLoanAccount,
  MemberLoanAccountDocument,
} from '../loans/schemas/member-loan-account.schema';
import { Loan, LoanDocument } from '../loans/schemas/loan.schema';
import { REPAYMENT_APPLIED_EVENT, RepaymentAppliedEvent } from './events/repayments.events';
import {
  EarlyLiquidationRequest,
  EarlyLiquidationRequestDocument,
} from './schemas/early-liquidation-request.schema';
import { RepaymentRecord, RepaymentRecordDocument } from './schemas/repayment-record.schema';

const EARLY_LIQUIDATION_ACTION = 'REQUEST';

export interface InitiateEarlyLiquidationResult {
  request: EarlyLiquidationRequestDocument;
  workflowRequest: WorkflowRequestDocument;
}

/**
 * *** ASSUMPTION CONFIRMED, SEE PHASE_9_NOTES.md ***
 * Workflow-mediated, single-step approval — treated as a distinct
 * account-closing event from ordinary repayment recording (§1's two-step
 * chain). The single step requires `approveCapability(EARLY_LIQUIDATION)`
 * (ADMIN/SUPERADMIN/APPROVER) — the brief says "Admin/Manager approval" but
 * MANAGER never holds an approve-capability anywhere else in this codebase's
 * established model (only review); resolved to the established convention,
 * flagged for confirmation.
 */
@Injectable()
export class EarlyLiquidationService implements OnModuleInit {
  constructor(
    @InjectModel(EarlyLiquidationRequest.name)
    private readonly earlyLiquidationRequestModel: Model<EarlyLiquidationRequestDocument>,
    @InjectModel(RepaymentRecord.name)
    private readonly repaymentRecordModel: Model<RepaymentRecordDocument>,
    @InjectModel(MemberLoanAccount.name)
    private readonly memberLoanAccountModel: Model<MemberLoanAccountDocument>,
    @InjectModel(Loan.name) private readonly loanModel: Model<LoanDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly loanProductsService: LoanProductsService,
    private readonly feeDefinitionsService: FeeDefinitionsService,
    private readonly workflowEngineService: WorkflowEngineService,
    private readonly auditService: AuditService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.workflowEngineService.registerChainConfig({
      entityType: WorkflowEntityType.EARLY_LIQUIDATION,
      action: EARLY_LIQUIDATION_ACTION,
      restartOnReturn: true,
      steps: [
        { order: 0, requiredCapability: approveCapability(WorkflowEntityType.EARLY_LIQUIDATION) },
      ],
    });
  }

  // ---------------------------------------------------------------------------
  // Initiation
  // ---------------------------------------------------------------------------

  async initiateEarlyLiquidation(
    memberLoanAccountId: string,
    initiatedBy: string,
  ): Promise<InitiateEarlyLiquidationResult> {
    const account = await this.memberLoanAccountModel.findById(memberLoanAccountId).exec();
    if (!account) {
      throw new NotFoundException(`MemberLoanAccount ${memberLoanAccountId} not found`);
    }
    if (account.status !== MemberLoanAccountStatus.ACTIVE) {
      throw new ConflictException(
        `MemberLoanAccount ${memberLoanAccountId} is not ACTIVE (status: ${account.status})`,
      );
    }

    const loan = await this.loanModel.findById(account.loanId).exec();
    if (!loan) {
      throw new NotFoundException(`Loan ${account.loanId.toString()} not found`);
    }

    // Snapshot — never recomputed against a later, different outstanding balance.
    const outstandingBalanceAtRequestKobo = account.outstandingBalanceKobo ?? 0;
    const earlyLiquidationFee = await this.findEarlyLiquidationFee(loan.productId.toString());
    const liquidationFeeKobo = calculateEarlyLiquidationFee(
      earlyLiquidationFee,
      outstandingBalanceAtRequestKobo,
    );
    const totalPayableKobo = outstandingBalanceAtRequestKobo + liquidationFeeKobo;

    const now = new Date();
    const created = await this.earlyLiquidationRequestModel.create({
      memberLoanAccountId: account._id,
      outstandingBalanceAtRequestKobo,
      liquidationFeeKobo,
      totalPayableKobo,
      status: EarlyLiquidationStatus.PENDING_APPROVAL,
      requestedBy: new Types.ObjectId(initiatedBy),
      requestedAt: now,
    });

    const workflowRequest = await this.workflowEngineService.initiate({
      entityType: WorkflowEntityType.EARLY_LIQUIDATION,
      action: EARLY_LIQUIDATION_ACTION,
      payload: { liquidationRequestId: created._id.toString() },
      initiatedBy,
      branchId: loan.branchId.toString(),
      entityId: created._id.toString(),
    });

    return { request: created, workflowRequest };
  }

  /**
   * The product's linked EARLY_LIQUIDATION-category fee. No described policy
   * for a product with more than one — takes the first found and flags this
   * as an unhandled edge case rather than silently picking arbitrarily among
   * many with different semantics. See PHASE_9_NOTES.md.
   *
   * Public — reused as-is by `PenaltySweepService` to find the same fee's
   * `frequency`/`recurrenceIntervalDays` for the recurring delay-charge sweep,
   * rather than duplicating this lookup.
   */
  async findEarlyLiquidationFee(productId: string): Promise<FeeDefinitionDocument> {
    const product = await this.loanProductsService.findByIdOrThrow(productId);
    const productFeeIds = new Set(product.feeIds.map((id) => id.toString()));
    const candidates = await this.feeDefinitionsService.findAll({
      category: FeeCategory.EARLY_LIQUIDATION,
      active: true,
    });
    const match = candidates.find((fee) => productFeeIds.has(fee._id.toString()));
    if (!match) {
      throw new BadRequestException(
        `LoanProduct ${productId} has no active EARLY_LIQUIDATION fee configured`,
      );
    }
    return match;
  }

  // ---------------------------------------------------------------------------
  // Workflow event dispatch
  // ---------------------------------------------------------------------------

  @OnEvent(WORKFLOW_APPROVED_EVENT)
  async handleWorkflowApproved(event: WorkflowApprovedEvent): Promise<void> {
    if (
      (event.entityType as WorkflowEntityType) !== WorkflowEntityType.EARLY_LIQUIDATION ||
      event.action !== EARLY_LIQUIDATION_ACTION ||
      !event.entityId
    ) {
      return;
    }

    const now = new Date();
    await this.earlyLiquidationRequestModel
      .updateOne(
        { _id: event.entityId },
        { $set: { status: EarlyLiquidationStatus.APPROVED, approvedAt: now } },
      )
      .exec();

    await this.auditService.record({
      actorId: event.initiatedBy,
      action: 'EARLY_LIQUIDATION_APPROVED',
      entityType: 'EARLY_LIQUIDATION_REQUEST',
      entityId: event.entityId,
      after: { status: EarlyLiquidationStatus.APPROVED },
      metadata: { workflowRequestId: event.workflowRequestId },
    });
  }

  @OnEvent(WORKFLOW_REJECTED_EVENT)
  async handleWorkflowRejected(event: WorkflowRejectedEvent): Promise<void> {
    if (
      (event.entityType as WorkflowEntityType) !== WorkflowEntityType.EARLY_LIQUIDATION ||
      event.action !== EARLY_LIQUIDATION_ACTION ||
      !event.entityId
    ) {
      return;
    }

    await this.earlyLiquidationRequestModel
      .updateOne({ _id: event.entityId }, { $set: { status: EarlyLiquidationStatus.REJECTED } })
      .exec();

    await this.auditService.record({
      actorId: event.rejectedBy,
      action: 'EARLY_LIQUIDATION_REJECTED',
      entityType: 'EARLY_LIQUIDATION_REQUEST',
      entityId: event.entityId,
      after: { status: EarlyLiquidationStatus.REJECTED },
      metadata: { workflowRequestId: event.workflowRequestId, comment: event.comment ?? null },
    });
  }

  // ---------------------------------------------------------------------------
  // Linking + completion
  // ---------------------------------------------------------------------------

  /**
   * Call when recording the settling payment (§1's normal recordRepayment
   * flow) so the repayment-approval path knows to check completion — see
   * `handleRepaymentApplied`. Only linkable while the target repayment is
   * still PENDING (i.e. before its own approval already applied it as an
   * ordinary, un-linked repayment).
   */
  async linkRepaymentToLiquidation(
    repaymentRecordId: string,
    liquidationRequestId: string,
  ): Promise<RepaymentRecordDocument> {
    const liquidationRequest = await this.earlyLiquidationRequestModel
      .findById(liquidationRequestId)
      .exec();
    if (!liquidationRequest) {
      throw new NotFoundException(`EarlyLiquidationRequest ${liquidationRequestId} not found`);
    }
    if (liquidationRequest.status !== EarlyLiquidationStatus.APPROVED) {
      throw new ConflictException(
        `EarlyLiquidationRequest ${liquidationRequestId} is not APPROVED (status: ${liquidationRequest.status})`,
      );
    }

    const repayment = await this.repaymentRecordModel.findById(repaymentRecordId).exec();
    if (!repayment) {
      throw new NotFoundException(`RepaymentRecord ${repaymentRecordId} not found`);
    }
    if (repayment.status !== RepaymentStatus.PENDING) {
      throw new ConflictException(
        `RepaymentRecord ${repaymentRecordId} must be PENDING to link (status: ${repayment.status})`,
      );
    }

    const updated = await this.repaymentRecordModel
      .findOneAndUpdate(
        { _id: repaymentRecordId },
        { $set: { linkedLiquidationRequestId: liquidationRequest._id } },
        { new: true },
      )
      .exec();
    if (!updated) {
      throw new NotFoundException(`RepaymentRecord ${repaymentRecordId} not found`);
    }

    await this.earlyLiquidationRequestModel
      .updateOne(
        { _id: liquidationRequestId },
        { $set: { linkedRepaymentRecordId: repayment._id } },
      )
      .exec();

    return updated;
  }

  /**
   * Reacts to RepaymentsService.applyToBalance actually applying a payment —
   * checks whether it was linked to a liquidation request and, if so,
   * whether it clears `totalPayableKobo`. See PHASE_9_NOTES.md for why this
   * is event-driven rather than a direct call (keeps RepaymentsService
   * unaware EarlyLiquidationService exists).
   */
  @OnEvent(REPAYMENT_APPLIED_EVENT)
  async handleRepaymentApplied(event: RepaymentAppliedEvent): Promise<void> {
    const repayment = await this.repaymentRecordModel.findById(event.repaymentRecordId).exec();
    if (!repayment?.linkedLiquidationRequestId) {
      return;
    }
    await this.checkCompletion(repayment);
  }

  /**
   * `amountKobo >= totalPayableKobo` completes the liquidation (slight
   * overpayment is fine — the normal `applyToBalance` capping logic already
   * handled the account-balance side of it). A short/partial linked payment
   * does NOT complete the liquidation — it was already applied as an
   * ordinary partial repayment by `applyToBalance`; no automatic partial-
   * liquidation reconciliation is built here, per the brief. Idempotent —
   * guarded by only transitioning a request that isn't already COMPLETED.
   */
  private async checkCompletion(repayment: RepaymentRecordDocument): Promise<void> {
    const liquidationRequestId = repayment.linkedLiquidationRequestId;
    if (!liquidationRequestId) {
      return;
    }
    const liquidationRequest = await this.earlyLiquidationRequestModel
      .findById(liquidationRequestId)
      .exec();
    if (!liquidationRequest || liquidationRequest.status === EarlyLiquidationStatus.COMPLETED) {
      return;
    }
    if (repayment.amountKobo < liquidationRequest.totalPayableKobo) {
      return;
    }

    const session = await this.connection.startSession();
    let completed = false;
    try {
      await session.withTransaction(async () => {
        const updatedRequest = await this.earlyLiquidationRequestModel
          .findOneAndUpdate(
            { _id: liquidationRequestId, status: { $ne: EarlyLiquidationStatus.COMPLETED } },
            { $set: { status: EarlyLiquidationStatus.COMPLETED } },
            { session, new: true },
          )
          .exec();
        if (!updatedRequest) {
          return; // Already completed by a concurrent call — idempotent no-op.
        }

        // "Cancel all remaining unpaid schedule entries" — embodied by
        // zeroing the balance and closing the account; individual schedule
        // entries carry no cancellation flag in this schema (not specified
        // by the brief) and are left as an untouched historical record. See
        // PHASE_9_NOTES.md.
        await this.memberLoanAccountModel
          .updateOne(
            { _id: repayment.memberLoanAccountId },
            { $set: { outstandingBalanceKobo: 0, status: MemberLoanAccountStatus.CLOSED } },
            { session },
          )
          .exec();
        completed = true;
      });
    } finally {
      await session.endSession();
    }

    if (completed) {
      await this.auditService.record({
        actorId: null,
        action: 'EARLY_LIQUIDATION_COMPLETED',
        entityType: 'EARLY_LIQUIDATION_REQUEST',
        entityId: liquidationRequestId.toString(),
        after: { status: EarlyLiquidationStatus.COMPLETED },
        metadata: { repaymentRecordId: repayment._id.toString() },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  async findByIdOrThrow(liquidationRequestId: string): Promise<EarlyLiquidationRequestDocument> {
    const doc = await this.earlyLiquidationRequestModel.findById(liquidationRequestId).exec();
    if (!doc) {
      throw new NotFoundException(`EarlyLiquidationRequest ${liquidationRequestId} not found`);
    }
    return doc;
  }
}
