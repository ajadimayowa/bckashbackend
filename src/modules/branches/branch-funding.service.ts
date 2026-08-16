import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';

import { BranchFundingStatus } from '../../common/enums/branch.enums';
import { AuditService } from '../../platform/audit/audit.service';
import { BranchFundBalanceService } from './branch-fund-balance.service';
import { BranchManagerAssignmentService } from './branch-manager-assignment.service';
import { RecordBranchFundingDto } from './dto/record-branch-funding.dto';
import { BranchFunding, BranchFundingDocument } from './schemas/branch-funding.schema';

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
    private readonly auditService: AuditService,
  ) {}

  async recordFunding(
    dto: RecordBranchFundingDto,
    recordedBy: string,
  ): Promise<BranchFundingDocument> {
    return this.fundingModel.create({
      branchId: dto.branchId,
      amount: dto.amount,
      fundedAt: new Date(dto.fundedAt),
      reference: dto.reference ?? null,
      recordedBy,
      status: BranchFundingStatus.PENDING_VERIFICATION,
    });
  }

  async findAll(branchId?: string): Promise<BranchFundingDocument[]> {
    const filter = branchId ? { branchId } : {};
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
                verifiedBy: actorId,
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

    return updated;
  }
}
