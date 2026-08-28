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

import { StaffRole } from '../../common/enums/identity.enums';
import { MemberLoanAccountStatus } from '../../common/enums/loan.enums';
import { EarlyLiquidationStatus, RepaymentStatus } from '../../common/enums/repayment.enums';
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
import {
  NOTIFICATION_PORT,
  NotificationPort,
} from '../loans/interfaces/notification-port.interface';
import { LoansService } from '../loans/loans.service';
import { RecordRepaymentDto } from './dto/record-repayment.dto';
import { REPAYMENT_APPLIED_EVENT, RepaymentAppliedEvent } from './events/repayments.events';
import {
  EarlyLiquidationRequest,
  EarlyLiquidationRequestDocument,
} from './schemas/early-liquidation-request.schema';
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
    // Only ever read here (never written) — to widen the record-time
    // overpayment cap for a repayment settling an approved early
    // liquidation, whose totalPayableKobo is deliberately greater than the
    // account's own outstandingBalanceKobo (it includes the liquidation
    // fee). See recordRepayment's own comment.
    @InjectModel(EarlyLiquidationRequest.name)
    private readonly earlyLiquidationRequestModel: Model<EarlyLiquidationRequestDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly workflowEngineService: WorkflowEngineService,
    private readonly auditService: AuditService,
    private readonly eventEmitter: EventEmitter2,
    @Inject(LEDGER_POSTING_PORT) private readonly ledgerPostingPort: LedgerPostingPort,
    @Inject(S3_ADAPTER) private readonly s3Adapter: S3Adapter,
    // Phase 11 retrofit — see raiseDispute's own comment and PHASE_11_NOTES.md.
    @Inject(NOTIFICATION_PORT) private readonly notificationPort: NotificationPort,
    // Cross-module service injection (not just raw model access, unlike
    // memberLoanAccountModel/loanModel above) — see LoansService.
    // syncCompletionStatus's own doc comment. Safe: RepaymentsModule already
    // imports LoansModule (see LoanDetailService in this same module), and
    // LoansModule never imports back.
    private readonly loansService: LoansService,
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

    // Rejected outright now, not just capped-and-flagged — a marketer
    // recording a repayment must never be able to enter more than what's
    // actually still owed on this specific member's account (not the loan's
    // aggregate outstandingBalanceKobo — see LoanDetailBorrower's own
    // per-member figure on the frontend, same thing this checks against).
    // `applyToBalance`'s own Math.min cap further down the pipeline stays as
    // is — that one's a different concern (reconciling two still-pending
    // repayments raised concurrently against the same account, only
    // resolvable once one of them is actually approved), not a substitute
    // for catching the obvious case at record time.
    //
    // Exception: an approved-but-not-yet-completed EarlyLiquidationRequest
    // against this account legitimately raises the ceiling to its own
    // totalPayableKobo (outstandingBalanceKobo + the liquidation fee — see
    // EarlyLiquidationService.initiateEarlyLiquidation) — the whole point of
    // settling one is paying more than the plain outstanding balance. The
    // repayment is only linked to the liquidation request *after* it's
    // recorded (EarlyLiquidationService.linkRepaymentToLiquidation), so this
    // can't key off the repayment itself — it looks up the account's
    // current APPROVED liquidation request directly instead.
    const outstandingBalanceKobo = account.outstandingBalanceKobo ?? 0;
    let maxAllowedKobo = outstandingBalanceKobo;
    const approvedLiquidation = await this.earlyLiquidationRequestModel
      .findOne({ memberLoanAccountId: account._id, status: EarlyLiquidationStatus.APPROVED })
      .exec();
    if (approvedLiquidation && approvedLiquidation.totalPayableKobo > maxAllowedKobo) {
      maxAllowedKobo = approvedLiquidation.totalPayableKobo;
    }
    if (dto.amountKobo > maxAllowedKobo) {
      throw new BadRequestException(
        `Amount can't be greater than outstanding balance (₦${(maxAllowedKobo / 100).toLocaleString('en-NG')})`,
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

    // Tells the branch's manager (the review step's actor) a repayment is
    // waiting on them — otherwise it only surfaces once they happen to check
    // the pending queue themselves. Best-effort: a notification failure here
    // shouldn't roll back an already-recorded repayment/workflow request.
    await this.notificationPort
      .sendRepaymentSubmittedForReview({
        repaymentRecordId: created._id.toString(),
        branchId: loan.branchId.toString(),
        recordedBy,
        amountKobo: dto.amountKobo,
      })
      .catch((error) =>
        this.logger.warn(
          `Failed to notify branch manager of repayment ${created._id.toString()}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );

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
    // Set only when this repayment's decrement brings the account's own
    // balance to exactly 0 — the loan-level completion resync (below,
    // post-commit, same "not inside the transaction" reasoning as ledger
    // posting) is only ever worth running when something CLOSED-relevant
    // just changed.
    let closedAccountLoanId: string | null = null;
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
          closedAccountLoanId = guarded.loanId.toString();
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

      if (closedAccountLoanId) {
        await this.loansService.syncCompletionStatus(closedAccountLoanId).catch((error) => {
          this.logger.error(
            `Failed to resync completion status for loan ${closedAccountLoanId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
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
    let reopenedAccountLoanId: string | null = null;
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
          reopenedAccountLoanId = guarded.loanId.toString();
        }
      });
    } finally {
      await session.endSession();
    }

    // Post-commit, same "not inside the transaction" reasoning as
    // applyToBalance's own loan-completion resync — a Loan this reopened
    // account belongs to may have been marked CLOSED and now needs to go
    // back to DISBURSED (see LoansService.syncCompletionStatus's own doc
    // comment).
    if (reopenedAccountLoanId) {
      await this.loansService.syncCompletionStatus(reopenedAccountLoanId).catch((error) => {
        this.logger.error(
          `Failed to resync completion status for loan ${reopenedAccountLoanId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
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

    // *** PHASE 11 CROSS-PHASE RETROFIT — see PHASE_11_NOTES.md. Not part of
    // this method's original Phase 9 scope (notification wasn't built yet);
    // added when NotificationPort gained a real implementation. Staff-facing
    // — see NotificationPort.sendRepaymentDisputeRaised's own doc comment.
    // `relatedWorkflowRequestId` is the original REPAYMENT_RECORD approval
    // chain for this record (the first — and, in practice, only — one on
    // file), so the involved-parties resolver can find which Admin/
    // SuperAdmin already acted on it. ***
    const history = await this.workflowEngineService.getHistory(
      WorkflowEntityType.REPAYMENT_RECORD,
      repaymentId,
    );
    await this.notificationPort.sendRepaymentDisputeRaised({
      repaymentRecordId: repaymentId,
      branchId: updated.branchId.toString(),
      recordedBy: updated.recordedBy.toString(),
      raisedBy: actorId,
      reason,
      relatedWorkflowRequestId: history[0]?._id.toString() ?? '',
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

  /** Every RepaymentRecord raised against a loan, across every member, oldest first — used by the Loan Manager detail view to build a real payment history/schedule-allocation view. */
  async listForLoan(loanId: string): Promise<RepaymentRecordDocument[]> {
    return this.repaymentRecordModel
      .find({ loanId: new Types.ObjectId(loanId) })
      .sort({ paymentDate: 1 })
      .exec();
  }

  /**
   * Row-level scoping mirrors LoansService.listForActor exactly: ADMIN/
   * SUPERADMIN/APPROVER see every repayment (optionally narrowed by
   * `filter.branchId`/`filter.loanId`/`filter.status`); a MANAGER only ever
   * sees their own branch's repayments; anyone else (MARKETER) only sees
   * repayments they themselves recorded.
   */
  async listForActor(
    filter: { branchId?: string; loanId?: string; status?: RepaymentStatus },
    viewer: { staffId: string; role: StaffRole; branchId?: string },
  ): Promise<RepaymentRecordDocument[]> {
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
      query.recordedBy = new Types.ObjectId(viewer.staffId);
    } else if (filter.branchId) {
      query.branchId = new Types.ObjectId(filter.branchId);
    }

    if (filter.loanId) {
      query.loanId = new Types.ObjectId(filter.loanId);
    }
    if (filter.status) {
      query.status = filter.status;
    }

    return this.repaymentRecordModel.find(query).sort({ paymentDate: -1 }).exec();
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
