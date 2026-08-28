import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Connection, Model, Types } from 'mongoose';

import { BranchFundingStatus } from '../../common/enums/branch.enums';
import { StaffRole } from '../../common/enums/identity.enums';
import { AuditService } from '../../platform/audit/audit.service';
import {
  S3_ADAPTER,
  S3Adapter,
} from '../../platform/integrations/s3/interfaces/s3-adapter.interface';
import { buildBranchFundingDisputeEvidenceObjectKey } from '../../platform/integrations/s3/s3-key.util';
import { BranchBankAccountsService } from './branch-bank-accounts.service';
import { BranchFundBalanceService } from './branch-fund-balance.service';
import { BranchManagerAssignmentService } from './branch-manager-assignment.service';
import { BranchesService } from './branches.service';
import { RecordBranchFundingDto } from './dto/record-branch-funding.dto';
import {
  BranchFundingDisputeRaisedEvent,
  BranchFundingDisputeResolvedEvent,
  BranchFundingNudgeRequestedEvent,
  BranchFundingRecordedEvent,
  BranchFundingRejectedEvent,
  BranchFundingVerifiedEvent,
  BRANCH_FUNDING_DISPUTE_RAISED_EVENT,
  BRANCH_FUNDING_DISPUTE_RESOLVED_EVENT,
  BRANCH_FUNDING_NUDGE_REQUESTED_EVENT,
  BRANCH_FUNDING_RECORDED_EVENT,
  BRANCH_FUNDING_REJECTED_EVENT,
  BRANCH_FUNDING_VERIFIED_EVENT,
} from './events/branch.events';
import {
  BranchFunding,
  BranchFundingDisputeDetails,
  BranchFundingDocument,
} from './schemas/branch-funding.schema';

/**
 * Deliberately not routed through the generic workflow engine — a two-party
 * confirmation (head office records, the branch's *current* manager verifies
 * or rejects) rather than a multi-step review chain. See PHASE_4_NOTES.md.
 */
@Injectable()
export class BranchFundingService {
  constructor(
    @InjectModel(BranchFunding.name) private readonly fundingModel: Model<BranchFundingDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly branchManagerAssignmentService: BranchManagerAssignmentService,
    private readonly branchFundBalanceService: BranchFundBalanceService,
    private readonly branchBankAccountsService: BranchBankAccountsService,
    private readonly branchesService: BranchesService,
    private readonly auditService: AuditService,
    @Inject(S3_ADAPTER) private readonly s3Adapter: S3Adapter,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * `bankAccountId` must be an account that actually belongs to `branchId`
   * and is currently its *active* one — a branch with no active account
   * (e.g. one that's never had a bank account added yet) can't be funded at
   * all until it has one. Recorded on the funding record itself so there's
   * always a durable answer to "which account was this destined for",
   * independent of whichever account is active by the time anyone looks
   * back at the history.
   */
  async recordFunding(
    dto: RecordBranchFundingDto,
    recordedBy: string,
  ): Promise<BranchFundingDocument> {
    const branch = await this.branchesService.findById(dto.branchId);
    if (!branch.active) {
      throw new BadRequestException(`Branch ${dto.branchId} is not active — it cannot be funded`);
    }

    // Verification is a two-party handoff (see this class's own doc
    // comment) — a funding record with nobody able to verify it would just
    // sit PENDING_VERIFICATION forever, so a branch needs a current manager
    // before head office can fund it at all.
    const currentManager = await this.branchManagerAssignmentService.getCurrentManager(dto.branchId);
    if (!currentManager) {
      throw new BadRequestException(
        `Branch ${dto.branchId} has no manager assigned — assign one before it can be funded`,
      );
    }

    const bankAccount = await this.branchBankAccountsService.findById(dto.bankAccountId);
    if (bankAccount.branchId.toString() !== dto.branchId) {
      throw new BadRequestException(
        `Bank account ${dto.bankAccountId} does not belong to branch ${dto.branchId}`,
      );
    }
    if (!bankAccount.active) {
      throw new BadRequestException(
        `Bank account ${dto.bankAccountId} is not this branch's active account — activate it first`,
      );
    }

    // Explicit Types.ObjectId casts — same recurring bug class documented
    // throughout this codebase (BranchFundBalanceService/BranchesService
    // .getStats/staff.service.ts/BranchFundingService.raiseDispute's own
    // `raisedBy` cast): a plain string does not reliably cast against this
    // schema's ObjectId-typed paths via @nestjs/mongoose's @Prop, including
    // on .create() — empirically confirmed leaving branchId/bankAccountId/
    // recordedBy stored as raw strings, which then silently fail to match
    // any ObjectId-typed query filter (findAll's row-scoping chief among
    // them — a funding record recorded this way is invisible to both the
    // branch's own manager and an admin's `?branchId=` filter, even though
    // the unfiltered list still returns it).
    const created = await this.fundingModel.create({
      branchId: new Types.ObjectId(dto.branchId),
      bankAccountId: new Types.ObjectId(dto.bankAccountId),
      amount: dto.amount,
      fundedAt: new Date(dto.fundedAt),
      reference: dto.reference ?? null,
      recordedBy: new Types.ObjectId(recordedBy),
      status: BranchFundingStatus.PENDING_VERIFICATION,
    });

    this.eventEmitter.emit(BRANCH_FUNDING_RECORDED_EVENT, {
      fundingId: created._id.toString(),
      branchId: dto.branchId,
      amountKobo: dto.amount,
      fundedAt: created.fundedAt.toISOString(),
      recordedBy,
    } satisfies BranchFundingRecordedEvent);

    return created;
  }

  /**
   * Row-scoped like LoansService.listForActor: ADMIN/SUPERADMIN/APPROVER see
   * every funding record (optionally narrowed by `branchId`); anyone else
   * (a Manager confirming their own branch's funding, most commonly) only
   * ever sees their own branch's — `branchId` is ignored for them, same
   * "the real gate is server-side, not whatever the caller asked for"
   * reasoning as every other row-scoped list in this codebase.
   *
   * *** Explicit Types.ObjectId cast below — same bug class documented on
   * BranchFundBalanceService/BranchesService.getStats/staff.service.ts: a
   * plain string does not reliably cast against this schema's
   * ObjectId-typed `branchId` path in this codebase's Mongoose setup. ***
   */
  async findAll(
    branchId: string | undefined,
    viewer: { staffId: string; role: StaffRole; branchId?: string },
  ): Promise<BranchFundingDocument[]> {
    const isAdminTier =
      viewer.role === StaffRole.ADMIN ||
      viewer.role === StaffRole.SUPERADMIN ||
      viewer.role === StaffRole.APPROVER;

    const filter: Record<string, unknown> = {};
    if (isAdminTier) {
      if (branchId) filter.branchId = new Types.ObjectId(branchId);
    } else {
      if (!viewer.branchId) return [];
      filter.branchId = new Types.ObjectId(viewer.branchId);
    }

    return this.fundingModel.find(filter).sort({ createdAt: -1 }).exec();
  }

  async findById(id: string): Promise<BranchFundingDocument> {
    const funding = await this.fundingModel.findById(id).exec();
    if (!funding) {
      throw new NotFoundException(`BranchFunding ${id} not found`);
    }
    return funding;
  }

  /** Throws if `actorId` is not the branch's *current* manager — no exception for higher-privileged roles. */
  private async assertActorIsCurrentManager(branchId: string, actorId: string): Promise<void> {
    const currentManager = await this.branchManagerAssignmentService.getCurrentManager(branchId);
    if (!currentManager || currentManager.staffId.toString() !== actorId) {
      throw new ForbiddenException(
        `Only branch ${branchId}'s current manager may verify or reject this funding record`,
      );
    }
  }

  /**
   * Status update + balance credit happen inside one Mongo transaction —
   * they must not be separable, or a verified funding record could exist
   * that never actually became spendable (or vice versa: a credited balance
   * whose funding record still shows PENDING_VERIFICATION).
   */
  async verifyFunding(fundingId: string, actorId: string): Promise<BranchFundingDocument> {
    const funding = await this.findById(fundingId);

    if (funding.status !== BranchFundingStatus.PENDING_VERIFICATION) {
      throw new ConflictException(
        `BranchFunding ${fundingId} is ${funding.status}, not PENDING_VERIFICATION — cannot verify`,
      );
    }

    await this.assertActorIsCurrentManager(funding.branchId.toString(), actorId);

    const session = await this.connection.startSession();
    let updated: BranchFundingDocument | null = null;

    try {
      await session.withTransaction(async () => {
        updated = await this.fundingModel
          .findOneAndUpdate(
            { _id: fundingId, status: BranchFundingStatus.PENDING_VERIFICATION },
            {
              $set: {
                status: BranchFundingStatus.VERIFIED,
                verifiedBy: new Types.ObjectId(actorId),
                verifiedAt: new Date(),
              },
            },
            { new: true, session },
          )
          .exec();

        if (!updated) {
          throw new ConflictException(
            `BranchFunding ${fundingId} was concurrently modified — retry the verification`,
          );
        }

        await this.branchFundBalanceService.credit(
          funding.branchId.toString(),
          funding.amount,
          session,
        );
      });
    } finally {
      await session.endSession();
    }

    // Unreachable-if-null: withTransaction only resolves normally once the
    // callback above completed without throwing, at which point `updated` is set.
    if (!updated) {
      throw new Error(
        `BranchFunding ${fundingId} verification transaction completed without a result`,
      );
    }

    await this.auditService.record({
      actorId,
      action: 'BRANCH_FUNDING_VERIFIED',
      entityType: 'BRANCH_FUNDING',
      entityId: fundingId,
      before: { status: BranchFundingStatus.PENDING_VERIFICATION },
      after: { status: BranchFundingStatus.VERIFIED, amount: funding.amount },
      metadata: { branchId: funding.branchId.toString() },
    });

    this.eventEmitter.emit(BRANCH_FUNDING_VERIFIED_EVENT, {
      fundingId,
      branchId: funding.branchId.toString(),
      amountKobo: funding.amount,
      verifiedBy: actorId,
    } satisfies BranchFundingVerifiedEvent);

    return updated;
  }

  async rejectFunding(
    fundingId: string,
    actorId: string,
    reason: string,
  ): Promise<BranchFundingDocument> {
    const funding = await this.findById(fundingId);

    if (funding.status !== BranchFundingStatus.PENDING_VERIFICATION) {
      throw new ConflictException(
        `BranchFunding ${fundingId} is ${funding.status}, not PENDING_VERIFICATION — cannot reject`,
      );
    }
    if (!reason) {
      throw new BadRequestException('A reason is required to reject a funding record');
    }

    await this.assertActorIsCurrentManager(funding.branchId.toString(), actorId);

    const updated = await this.fundingModel
      .findOneAndUpdate(
        { _id: fundingId, status: BranchFundingStatus.PENDING_VERIFICATION },
        { $set: { status: BranchFundingStatus.REJECTED, rejectionReason: reason } },
        { new: true },
      )
      .exec();
    if (!updated) {
      throw new ConflictException(
        `BranchFunding ${fundingId} was concurrently modified — retry the rejection`,
      );
    }

    await this.auditService.record({
      actorId,
      action: 'BRANCH_FUNDING_REJECTED',
      entityType: 'BRANCH_FUNDING',
      entityId: fundingId,
      before: { status: BranchFundingStatus.PENDING_VERIFICATION },
      after: { status: BranchFundingStatus.REJECTED },
      metadata: { reason, branchId: funding.branchId.toString() },
    });

    this.eventEmitter.emit(BRANCH_FUNDING_REJECTED_EVENT, {
      fundingId,
      branchId: funding.branchId.toString(),
      amountKobo: funding.amount,
      rejectedBy: actorId,
      reason,
    } satisfies BranchFundingRejectedEvent);

    return updated;
  }

  // ---------------------------------------------------------------------------
  // Nudge — a manual "please confirm this" email to the branch's current manager
  // ---------------------------------------------------------------------------

  /**
   * Head-office only (same BRANCH_FUND_CAPABILITY tier that records funding
   * in the first place — see the controller's own gate). A no-op-if-resolved
   * guard: nudging a VERIFIED/REJECTED record makes no sense, there's
   * nothing left for the manager to confirm.
   */
  async nudgeManager(fundingId: string, nudgedBy: string): Promise<BranchFundingDocument> {
    const funding = await this.findById(fundingId);
    if (funding.status !== BranchFundingStatus.PENDING_VERIFICATION) {
      throw new ConflictException(
        `BranchFunding ${fundingId} is ${funding.status}, not PENDING_VERIFICATION — nothing to nudge`,
      );
    }

    const updated = await this.fundingModel
      .findOneAndUpdate({ _id: fundingId }, { $set: { lastNudgedAt: new Date() } }, { new: true })
      .exec();
    if (!updated) {
      throw new NotFoundException(`BranchFunding ${fundingId} not found`);
    }

    this.eventEmitter.emit(BRANCH_FUNDING_NUDGE_REQUESTED_EVENT, {
      fundingId,
      branchId: funding.branchId.toString(),
      amountKobo: funding.amount,
      fundedAt: funding.fundedAt.toISOString(),
      nudgedBy,
    } satisfies BranchFundingNudgeRequestedEvent);

    await this.auditService.record({
      actorId: nudgedBy,
      action: 'BRANCH_FUNDING_MANAGER_NUDGED',
      entityType: 'BRANCH_FUNDING',
      entityId: fundingId,
      metadata: { branchId: funding.branchId.toString() },
    });

    return updated;
  }

  // ---------------------------------------------------------------------------
  // Disputes — the branch's own current manager raises one (with required
  // document evidence); an Admin/SuperAdmin resolves it. Deliberately
  // doesn't touch `status`/the branch's fund balance — see
  // BranchFundingDisputeDetails' own doc comment.
  // ---------------------------------------------------------------------------

  async raiseDispute(
    fundingId: string,
    actorId: string,
    reason: string,
    evidence: { buffer: Buffer; contentType: string },
  ): Promise<BranchFundingDocument> {
    const funding = await this.findById(fundingId);
    await this.assertActorIsCurrentManager(funding.branchId.toString(), actorId);

    // Same PENDING_VERIFICATION-only gate as verify/reject/nudge above — once
    // approved, the amount has already been credited to the branch balance
    // (see verifyFunding), so disputing it after the fact has no reversal
    // mechanism to land on; once rejected, there's nothing left to dispute
    // either. A dispute only ever makes sense while the record is still
    // awaiting the branch manager's own decision.
    if (funding.status !== BranchFundingStatus.PENDING_VERIFICATION) {
      throw new BadRequestException(
        `BranchFunding ${fundingId} is ${funding.status}, not PENDING_VERIFICATION — cannot raise a dispute`,
      );
    }

    if (funding.disputeDetails && funding.disputeDetails.resolution === null) {
      throw new ConflictException(
        `BranchFunding ${fundingId} already has an open dispute — it must be resolved before another can be raised`,
      );
    }

    const extension = evidence.contentType.split('/')[1] ?? 'jpg';
    const evidenceImageKey = buildBranchFundingDisputeEvidenceObjectKey(fundingId, extension);
    await this.s3Adapter.upload(evidenceImageKey, evidence.buffer, evidence.contentType);

    const disputeDetails: BranchFundingDisputeDetails = {
      raisedBy: new Types.ObjectId(actorId),
      reason,
      evidenceImageKey,
      raisedAt: new Date(),
      resolution: null,
      resolvedBy: null,
      resolvedAt: null,
      resolutionNote: null,
    };

    const updated = await this.fundingModel
      .findOneAndUpdate({ _id: fundingId }, { $set: { disputeDetails } }, { new: true })
      .exec();
    if (!updated) {
      throw new NotFoundException(`BranchFunding ${fundingId} not found`);
    }

    await this.auditService.record({
      actorId,
      action: 'BRANCH_FUNDING_DISPUTE_RAISED',
      entityType: 'BRANCH_FUNDING',
      entityId: fundingId,
      after: { reason },
      metadata: { branchId: funding.branchId.toString() },
    });

    this.eventEmitter.emit(BRANCH_FUNDING_DISPUTE_RAISED_EVENT, {
      fundingId,
      branchId: funding.branchId.toString(),
      raisedBy: actorId,
      reason,
    } satisfies BranchFundingDisputeRaisedEvent);

    return updated;
  }

  async resolveDispute(
    fundingId: string,
    actorId: string,
    resolution: 'RESOLVED' | 'DISMISSED',
    note: string,
  ): Promise<BranchFundingDocument> {
    const funding = await this.findById(fundingId);
    if (!funding.disputeDetails || funding.disputeDetails.resolution !== null) {
      throw new ConflictException(`BranchFunding ${fundingId} has no open dispute to resolve`);
    }

    const updated = await this.fundingModel
      .findOneAndUpdate(
        { _id: fundingId },
        {
          $set: {
            'disputeDetails.resolution': resolution,
            'disputeDetails.resolvedBy': new Types.ObjectId(actorId),
            'disputeDetails.resolvedAt': new Date(),
            'disputeDetails.resolutionNote': note,
          },
        },
        { new: true },
      )
      .exec();
    if (!updated) {
      throw new NotFoundException(`BranchFunding ${fundingId} not found`);
    }

    await this.auditService.record({
      actorId,
      action: 'BRANCH_FUNDING_DISPUTE_RESOLVED',
      entityType: 'BRANCH_FUNDING',
      entityId: fundingId,
      after: { resolution, note },
      metadata: { branchId: funding.branchId.toString() },
    });

    this.eventEmitter.emit(BRANCH_FUNDING_DISPUTE_RESOLVED_EVENT, {
      fundingId,
      branchId: funding.branchId.toString(),
      raisedBy: funding.disputeDetails.raisedBy.toString(),
      resolvedBy: actorId,
      resolution,
      note,
    } satisfies BranchFundingDisputeResolvedEvent);

    return updated;
  }

  /** null if there's no dispute, or the dispute has no evidence attached (shouldn't happen — evidence is required to raise one — but kept defensive). */
  async getDisputeEvidenceSignedUrl(fundingId: string, expiresInSeconds?: number): Promise<string | null> {
    const funding = await this.findById(fundingId);
    if (!funding.disputeDetails?.evidenceImageKey) {
      return null;
    }
    return this.s3Adapter.getSignedReadUrl(funding.disputeDetails.evidenceImageKey, expiresInSeconds);
  }
}
