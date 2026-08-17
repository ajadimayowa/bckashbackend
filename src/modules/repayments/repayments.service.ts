import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';

import { MemberLoanAccountStatus } from '../../common/enums/loan.enums';
import { RepaymentStatus } from '../../common/enums/repayment.enums';
import { WorkflowEntityType } from '../../common/enums/workflow.enums';
import { AuditService } from '../../platform/audit/audit.service';
import { approveCapability, reviewCapability } from '../../platform/rbac/constants/capabilities';
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
import { buildRepaymentProofObjectKey } from '../../platform/integrations/s3/s3-key.util';
// Cross-module raw schema registration only — same "raw model injection for
// existence checks / trusted cross-module writes" pattern GroupsModule uses
// for Branch/Customer, and the same reasoning `RealLoanStatusPort` uses for
// MemberLoanAccount. RepaymentsService directly decrements
// MemberLoanAccount.outstandingBalanceKobo per the brief's own example code
// — not proxied through a LoansService method, since none exists for this
// (Loans only ever *sets* the balance once, at disbursement). See
// PHASE_9_NOTES.md.
import {
  BranchBankAccount,
  BranchBankAccountDocument,
} from '../branches/schemas/branch-bank-account.schema';
import {
  MemberLoanAccount,
  MemberLoanAccountDocument,
} from '../loans/schemas/member-loan-account.schema';
import { Loan, LoanDocument } from '../loans/schemas/loan.schema';
import {
  LEDGER_POSTING_PORT,
  LedgerPostingPort,
} from '../loans/interfaces/ledger-posting-port.interface';
import { RecordRepaymentDto } from './dto/record-repayment.dto';
import { REPAYMENT_APPLIED_EVENT, RepaymentAppliedEvent } from './events/repayments.events';
import {
  DisputeDetails,
  RepaymentRecord,
  RepaymentRecordDocument,
} from './schemas/repayment-record.schema';

const REPAYMENT_RECORD_ACTION = 'RECORD';
/** N days — used by findStaleDisputes' default window. See PHASE_9_NOTES.md. */
const DEFAULT_STALE_DISPUTE_DAYS = 7;

export interface RecordRepaymentResult {
  record: RepaymentRecordDocument;
  workflowRequest: WorkflowRequestDocument;
}

@Injectable()
export class RepaymentsService implements OnModuleInit {
  private readonly logger = new Logger(RepaymentsService.name);

  constructor(
    @InjectModel(RepaymentRecord.name)
    private readonly repaymentRecordModel: Model<RepaymentRecordDocument>,
    @InjectModel(MemberLoanAccount.name)
    private readonly memberLoanAccountModel: Model<MemberLoanAccountDocument>,
    @InjectModel(Loan.name) private readonly loanModel: Model<LoanDocument>,
    @InjectModel(BranchBankAccount.name)
    private readonly branchBankAccountModel: Model<BranchBankAccountDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly workflowEngineService: WorkflowEngineService,
    private readonly auditService: AuditService,
    private readonly eventEmitter: EventEmitter2,
    @Inject(LEDGER_POSTING_PORT) private readonly ledgerPostingPort: LedgerPostingPort,
    @Inject(S3_ADAPTER) private readonly s3Adapter: S3Adapter,
  ) {}

  async onModuleInit(): Promise<void> {
    // ASSUMPTION (flagged, see PHASE_9_NOTES.md): two-step (review, then
    // approve) — consistent with Group/Customer (Phase 6), since repayment
    // approval directly affects a customer's debt balance. The brief doesn't
    // use the exact "reviewed and approved" phrasing for this module the way
    // it did for groups/customers, so this is a default, not a confirmed
    // reading — confirm before relying on it.
    await this.workflowEngineService.registerChainConfig({
      entityType: WorkflowEntityType.REPAYMENT_RECORD,
      action: REPAYMENT_RECORD_ACTION,
      restartOnReturn: true,
      steps: [
        { order: 0, requiredCapability: reviewCapability(WorkflowEntityType.REPAYMENT_RECORD) },
        { order: 1, requiredCapability: approveCapability(WorkflowEntityType.REPAYMENT_RECORD) },
      ],
    });
  }

  // ---------------------------------------------------------------------------
  // Recording
  // ---------------------------------------------------------------------------

  /**
   * DEVIATION from "nothing persists until approval" — see RepaymentRecord's
   * own doc comment. Created immediately; the workflow request is initiated
   * with this record's already-real `_id` as `entityId`, same pattern
   * established for Loan in Phase 8.
   */
  async recordRepayment(
    dto: RecordRepaymentDto,
    recordedBy: string,
  ): Promise<RecordRepaymentResult> {
    const account = await this.memberLoanAccountModel.findById(dto.memberLoanAccountId).exec();
    if (!account) {
      throw new NotFoundException(`MemberLoanAccount ${dto.memberLoanAccountId} not found`);
    }
    if (account.status !== MemberLoanAccountStatus.ACTIVE) {
      throw new ConflictException(
        `MemberLoanAccount ${dto.memberLoanAccountId} is not ACTIVE (status: ${account.status}) — cannot record a repayment against it`,
      );
    }

    const loan = await this.loanModel.findById(account.loanId).exec();
    if (!loan) {
      throw new NotFoundException(`Loan ${account.loanId.toString()} not found`);
    }

    const branchBankAccountExists = await this.branchBankAccountModel.exists({
      _id: dto.branchBankAccountId,
    });
    if (!branchBankAccountExists) {
      throw new BadRequestException(`BranchBankAccount ${dto.branchBankAccountId} does not exist`);
    }

    const now = new Date();
    let created: RepaymentRecordDocument;
    try {
      created = await this.repaymentRecordModel.create({
        loanId: account.loanId,
        memberLoanAccountId: account._id,
        customerId: account.customerId,
        branchId: loan.branchId,
        branchBankAccountId: new Types.ObjectId(dto.branchBankAccountId),
        channel: dto.channel,
        transactionReference: dto.transactionReference,
        amountKobo: dto.amountKobo,
        paymentDate: new Date(dto.paymentDate),
        recordedBy: new Types.ObjectId(recordedBy),
        recordedAt: now,
        status: RepaymentStatus.PENDING,
        appliedToBalance: false,
      });
    } catch (error) {
      // The DB-level unique index on (branchBankAccountId, transactionReference)
      // is the primary duplicate-entry defense, per the brief — surfaced here
      // as a clean 409 rather than a raw Mongo E11000 error.
      if (this.isDuplicateKeyError(error)) {
        throw new ConflictException(
          `A repayment with transactionReference "${dto.transactionReference}" already exists for this branch bank account`,
        );
      }
      throw error;
    }

    const workflowRequest = await this.workflowEngineService.initiate({
      entityType: WorkflowEntityType.REPAYMENT_RECORD,
      action: REPAYMENT_RECORD_ACTION,
      payload: { repaymentId: created._id.toString() },
      initiatedBy: recordedBy,
      branchId: loan.branchId.toString(),
      entityId: created._id.toString(),
    });

    return { record: created, workflowRequest };
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: number }).code === 11000
    );
  }

  // ---------------------------------------------------------------------------
  // Workflow event dispatch
  // ---------------------------------------------------------------------------

  @OnEvent(WORKFLOW_APPROVED_EVENT)
  async handleWorkflowApproved(event: WorkflowApprovedEvent): Promise<void> {
    if (
      (event.entityType as WorkflowEntityType) !== WorkflowEntityType.REPAYMENT_RECORD ||
      event.action !== REPAYMENT_RECORD_ACTION ||
      !event.entityId
    ) {
      return;
    }
    const repaymentId = event.entityId;

    await this.repaymentRecordModel
      .updateOne({ _id: repaymentId }, { $set: { status: RepaymentStatus.APPROVED } })
      .exec();

    await this.applyToBalance(repaymentId, event.initiatedBy);

    await this.auditService.record({
      actorId: event.initiatedBy,
      action: 'REPAYMENT_RECORD_APPROVED',
      entityType: 'REPAYMENT_RECORD',
      entityId: repaymentId,
      after: { status: RepaymentStatus.APPROVED },
      metadata: { workflowRequestId: event.workflowRequestId },
    });
  }

  @OnEvent(WORKFLOW_REJECTED_EVENT)
  async handleWorkflowRejected(event: WorkflowRejectedEvent): Promise<void> {
    if (
      (event.entityType as WorkflowEntityType) !== WorkflowEntityType.REPAYMENT_RECORD ||
      event.action !== REPAYMENT_RECORD_ACTION ||
      !event.entityId
    ) {
      return;
    }

    // No balance effect — nothing was ever applied (appliedToBalance stays false).
    await this.repaymentRecordModel
      .updateOne({ _id: event.entityId }, { $set: { status: RepaymentStatus.REJECTED } })
      .exec();

    await this.auditService.record({
      actorId: event.rejectedBy,
      action: 'REPAYMENT_RECORD_REJECTED',
      entityType: 'REPAYMENT_RECORD',
      entityId: event.entityId,
      after: { status: RepaymentStatus.REJECTED },
      metadata: { workflowRequestId: event.workflowRequestId, comment: event.comment ?? null },
    });
  }

  // ---------------------------------------------------------------------------
  // Balance application / reversal — the idempotent core both initial
  // approval AND dispute-resolution re-approval reuse (never duplicated).
  // ---------------------------------------------------------------------------

  /**
   * Idempotent — safe to call more than once for the same `repaymentId` (a
   * `workflow.approved` event firing twice, a retry). Only the call whose
   * conditional update actually flips `appliedToBalance` false -> true
   * performs the balance decrement; every other call is a silent no-op.
   *
   * Overpayment handling (flagged assumption, see PHASE_9_NOTES.md): caps
   * the decrement at the outstanding balance and records the excess as
   * `overpaymentAmountKobo` plus a dedicated audit entry, rather than
   * allowing a negative balance or auto-refunding.
   */
  async applyToBalance(repaymentId: string, actorId: string | null): Promise<void> {
    const session = await this.connection.startSession();
    let applied = false;
    let postingParams: { cappedAmount: number; branchId: string } | null = null;
    try {
      await session.withTransaction(async () => {
        const guarded = await this.repaymentRecordModel
          .findOneAndUpdate(
            { _id: repaymentId, appliedToBalance: false },
            { $set: { appliedToBalance: true } },
            { session, new: true },
          )
          .exec();
        if (!guarded) {
          // Already applied (or the record doesn't exist) — idempotent no-op.
          return;
        }

        const account = await this.memberLoanAccountModel
          .findById(guarded.memberLoanAccountId)
          .session(session)
          .exec();
        if (!account) {
          throw new Error(
            `MemberLoanAccount ${guarded.memberLoanAccountId.toString()} not found while applying repayment ${repaymentId}`,
          );
        }

        const currentBalance = account.outstandingBalanceKobo ?? 0;
        const cappedAmount = Math.min(guarded.amountKobo, currentBalance);
        const overpaymentAmountKobo =
          guarded.amountKobo > currentBalance ? guarded.amountKobo - currentBalance : null;

        const updatedAccount = await this.memberLoanAccountModel
          .findOneAndUpdate(
            { _id: guarded.memberLoanAccountId },
            [
              {
                $set: {
                  outstandingBalanceKobo: {
                    $max: [0, { $subtract: ['$outstandingBalanceKobo', cappedAmount] }],
                  },
                },
              },
            ],
            { session, new: true },
          )
          .exec();
        if (!updatedAccount) {
          throw new Error(
            `Failed to decrement outstandingBalanceKobo for MemberLoanAccount ${guarded.memberLoanAccountId.toString()}`,
          );
        }

        if (overpaymentAmountKobo !== null) {
          await this.repaymentRecordModel
            .updateOne({ _id: repaymentId }, { $set: { overpaymentAmountKobo } }, { session })
            .exec();
        }

        if (updatedAccount.outstandingBalanceKobo === 0) {
          await this.memberLoanAccountModel
            .updateOne(
              { _id: guarded.memberLoanAccountId },
              { $set: { status: MemberLoanAccountStatus.CLOSED } },
              { session },
            )
            .exec();
        }

        // Ledger posting deliberately happens AFTER this transaction commits
        // (see below, outside `withTransaction`) — not here. See
        // PHASE_10_NOTES.md: nesting LedgerPostingService's own
        // independently-managed session inside this still-open transaction
        // (both on the same connection) caused a genuine, reproducible
        // deadlock. It was never actually atomic with this transaction
        // anyway (LedgerPostingService never used the passed-in session for
        // its write), so deferring it to post-commit changes nothing about
        // the atomicity guarantee — it only removes the unsafe nesting.
        postingParams = { cappedAmount, branchId: guarded.branchId.toString() };
        applied = true;

        if (overpaymentAmountKobo !== null) {
          await this.auditService.record({
            actorId,
            action: 'REPAYMENT_OVERPAYMENT_FLAGGED',
            entityType: 'REPAYMENT_RECORD',
            entityId: repaymentId,
            after: { overpaymentAmountKobo },
            metadata: {
              memberLoanAccountId: guarded.memberLoanAccountId.toString(),
              amountKobo: guarded.amountKobo,
              cappedAmount,
            },
          });
        }
      });
    } finally {
      await session.endSession();
    }

    if (applied && postingParams) {
      const { cappedAmount: postedAmountKobo, branchId: postedBranchId } = postingParams;
      try {
        await this.ledgerPostingPort.postRepayment({
          repaymentRecordId: repaymentId,
          amountKobo: postedAmountKobo,
          branchId: postedBranchId,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Ledger posting failed for repayment ${repaymentId}: ${message}`);
        await this.auditService.record({
          actorId,
          action: 'LEDGER_POST_REPAYMENT_FAILED',
          entityType: 'REPAYMENT_RECORD',
          entityId: repaymentId,
          after: { amountKobo: postedAmountKobo, error: message },
        });
      }

      await this.eventEmitter.emitAsync(REPAYMENT_APPLIED_EVENT, {
        repaymentRecordId: repaymentId,
      } satisfies RepaymentAppliedEvent);
    }
  }

  /**
   * Idempotent mirror of `applyToBalance` — only the call whose conditional
   * update actually flips `appliedToBalance` true -> false performs the
   * reversal; a double-raise (two concurrent `raiseDispute` calls) cannot
   * double-reverse.
   */
  private async reverseBalance(repaymentId: string): Promise<void> {
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        const guarded = await this.repaymentRecordModel
          .findOneAndUpdate(
            { _id: repaymentId, appliedToBalance: true },
            { $set: { appliedToBalance: false } },
            { session, new: true },
          )
          .exec();
        if (!guarded) {
          // Not currently applied — nothing to reverse. Idempotent no-op.
          return;
        }

        // The exact amount originally applied — derived from the stored
        // amountKobo/overpaymentAmountKobo rather than a separate field,
        // since cappedAmount = amountKobo - overpaymentAmountKobo always.
        const cappedAmount = guarded.amountKobo - (guarded.overpaymentAmountKobo ?? 0);

        const updatedAccount = await this.memberLoanAccountModel
          .findOneAndUpdate(
            { _id: guarded.memberLoanAccountId },
            [
              {
                $set: {
                  outstandingBalanceKobo: { $add: ['$outstandingBalanceKobo', cappedAmount] },
                },
              },
            ],
            { session, new: true },
          )
          .exec();

        // A repayment that had closed the account (balance reached exactly
        // 0) must be reopened once its effect is reversed — not explicitly
        // specified by the brief, but the natural symmetric counterpart of
        // "balance reaching 0 closes the account." Flagged in PHASE_9_NOTES.md.
        if (
          updatedAccount &&
          updatedAccount.status === MemberLoanAccountStatus.CLOSED &&
          (updatedAccount.outstandingBalanceKobo ?? 0) > 0
        ) {
          await this.memberLoanAccountModel
            .updateOne(
              { _id: guarded.memberLoanAccountId },
              { $set: { status: MemberLoanAccountStatus.ACTIVE } },
              { session },
            )
            .exec();
        }
      });
    } finally {
      await session.endSession();
    }
  }

  // ---------------------------------------------------------------------------
  // Disputes
  // ---------------------------------------------------------------------------

  async raiseDispute(
    repaymentId: string,
    actorId: string,
    reason: string,
  ): Promise<RepaymentRecordDocument> {
    const record = await this.repaymentRecordModel.findById(repaymentId).exec();
    if (!record) {
      throw new NotFoundException(`RepaymentRecord ${repaymentId} not found`);
    }
    if (record.status !== RepaymentStatus.PENDING && record.status !== RepaymentStatus.APPROVED) {
      throw new ConflictException(
        `RepaymentRecord ${repaymentId} cannot be disputed from status ${record.status}`,
      );
    }

    // Reverse the balance effect first (if any) — idempotency guarded inside
    // reverseBalance itself, so a concurrent double-raise cannot double-reverse.
    if (record.status === RepaymentStatus.APPROVED && record.appliedToBalance) {
      await this.reverseBalance(repaymentId);
    }

    const disputeDetails: DisputeDetails = {
      raisedBy: new Types.ObjectId(actorId),
      reason,
      raisedAt: new Date(),
      resolution: null,
      resolvedBy: null,
      resolvedAt: null,
      note: null,
    };

    const updated = await this.repaymentRecordModel
      .findOneAndUpdate(
        { _id: repaymentId },
        { $set: { status: RepaymentStatus.UNDER_DISPUTE, disputeDetails } },
        { new: true },
      )
      .exec();
    if (!updated) {
      throw new NotFoundException(`RepaymentRecord ${repaymentId} not found`);
    }

    await this.auditService.record({
      actorId,
      action: 'REPAYMENT_DISPUTE_RAISED',
      entityType: 'REPAYMENT_RECORD',
      entityId: repaymentId,
      after: { status: RepaymentStatus.UNDER_DISPUTE, reason },
    });

    return updated;
  }

  /**
   * "APPROVED": re-applies the balance effect via the exact same idempotent
   * `applyToBalance` method used for initial approval — never duplicated.
   * "REJECTED": leaves the balance reversed (or never-applied, if disputed
   * from PENDING) — no further balance action.
   */
  async resolveDispute(
    repaymentId: string,
    actorId: string,
    resolution: 'APPROVED' | 'REJECTED',
    note: string,
  ): Promise<RepaymentRecordDocument> {
    if (!note || note.trim().length === 0) {
      throw new BadRequestException('A note is required to resolve a dispute');
    }

    const record = await this.repaymentRecordModel.findById(repaymentId).exec();
    if (!record) {
      throw new NotFoundException(`RepaymentRecord ${repaymentId} not found`);
    }
    if (record.status !== RepaymentStatus.UNDER_DISPUTE) {
      throw new ConflictException(
        `RepaymentRecord ${repaymentId} is not UNDER_DISPUTE (status: ${record.status})`,
      );
    }

    const now = new Date();
    const newStatus =
      resolution === 'APPROVED' ? RepaymentStatus.APPROVED : RepaymentStatus.REJECTED;

    await this.repaymentRecordModel
      .updateOne(
        { _id: repaymentId },
        {
          $set: {
            status: newStatus,
            'disputeDetails.resolution': resolution,
            'disputeDetails.resolvedBy': new Types.ObjectId(actorId),
            'disputeDetails.resolvedAt': now,
            'disputeDetails.note': note,
          },
        },
      )
      .exec();

    if (resolution === 'APPROVED') {
      await this.applyToBalance(repaymentId, actorId);
    }

    // Dispute resolution is a meaningful financial decision — logged
    // prominently regardless of outcome.
    await this.auditService.record({
      actorId,
      action: 'REPAYMENT_DISPUTE_RESOLVED',
      entityType: 'REPAYMENT_RECORD',
      entityId: repaymentId,
      before: { status: RepaymentStatus.UNDER_DISPUTE },
      after: { status: newStatus, resolution, note },
      metadata: { compliance: true },
    });

    const updated = await this.repaymentRecordModel.findById(repaymentId).exec();
    if (!updated) {
      throw new NotFoundException(`RepaymentRecord ${repaymentId} not found`);
    }
    return updated;
  }

  /** Optional — `proofOfPaymentImageKey` per the brief's schema. Attachable at any point, not gated by status. */
  async recordProofOfPayment(
    repaymentId: string,
    imageBuffer: Buffer,
    contentType: string,
  ): Promise<RepaymentRecordDocument> {
    await this.findByIdOrThrow(repaymentId); // throws if not found
    const extension = contentType.split('/')[1] ?? 'jpg';
    const key = buildRepaymentProofObjectKey(repaymentId, extension);
    await this.s3Adapter.upload(key, imageBuffer, contentType);

    const updated = await this.repaymentRecordModel
      .findOneAndUpdate(
        { _id: repaymentId },
        { $set: { proofOfPaymentImageKey: key } },
        { new: true },
      )
      .exec();
    if (!updated) {
      throw new NotFoundException(`RepaymentRecord ${repaymentId} not found`);
    }
    return updated;
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  async findByIdOrThrow(repaymentId: string): Promise<RepaymentRecordDocument> {
    const record = await this.repaymentRecordModel.findById(repaymentId).exec();
    if (!record) {
      throw new NotFoundException(`RepaymentRecord ${repaymentId} not found`);
    }
    return record;
  }

  /**
   * "Never leave a RepaymentRecord at UNDER_DISPUTE implicitly forgotten" —
   * a simple read method for Admin visibility, per the brief. Alerting/
   * escalation is left as a later notification hook, not built here.
   */
  async findStaleDisputes(
    olderThanDays: number = DEFAULT_STALE_DISPUTE_DAYS,
  ): Promise<RepaymentRecordDocument[]> {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    return this.repaymentRecordModel
      .find({
        status: RepaymentStatus.UNDER_DISPUTE,
        'disputeDetails.raisedAt': { $lte: cutoff },
      })
      .sort({ 'disputeDetails.raisedAt': 1 })
      .exec();
  }
}
