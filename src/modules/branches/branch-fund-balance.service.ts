import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model } from 'mongoose';

import { BRANCH_CREATED_EVENT, BranchCreatedEvent } from './events/branch.events';
import { InsufficientBranchFundsException } from './exceptions/insufficient-branch-funds.exception';
import { BranchFundBalance, BranchFundBalanceDocument } from './schemas/branch-fund-balance.schema';

/**
 * The fund-balance primitive Phase 8's disbursement flow will depend on.
 * `credit`/`debit` both accept an optional Mongo `session` so callers can
 * compose the balance change into a larger multi-document transaction
 * (funding verification here; disbursement + loan status + ledger entry in
 * Phase 8) — see PHASE_4_NOTES.md.
 */
@Injectable()
export class BranchFundBalanceService {
  private readonly logger = new Logger(BranchFundBalanceService.name);

  constructor(
    @InjectModel(BranchFundBalance.name)
    private readonly balanceModel: Model<BranchFundBalanceDocument>,
  ) {}

  /** Idempotent — safe even if a balance doc already exists (e.g. re-fired event). */
  @OnEvent(BRANCH_CREATED_EVENT)
  async handleBranchCreated(event: BranchCreatedEvent): Promise<void> {
    await this.balanceModel
      .updateOne(
        { branchId: event.branchId },
        { $setOnInsert: { branchId: event.branchId, availableAmount: 0 } },
        { upsert: true },
      )
      .exec();
    this.logger.log(`Initialized fund balance for branch ${event.branchId}`);
  }

  /**
   * Called by BranchFundingService.verifyFunding inside the same transaction
   * as the BranchFunding status update — upsert:true is defensive (the
   * balance doc should already exist via the branch.created listener above,
   * but a credit must never silently no-op just because that listener was
   * somehow missed).
   */
  async credit(
    branchId: string,
    amountKobo: number,
    session?: ClientSession,
  ): Promise<BranchFundBalanceDocument> {
    const result = await this.balanceModel
      .findOneAndUpdate(
        { branchId },
        { $inc: { availableAmount: amountKobo }, $set: { updatedAt: new Date() } },
        { new: true, upsert: true, session },
      )
      .exec();
    if (!result) {
      // Unreachable with upsert: true + new: true — guarding for strict null checks.
      throw new Error(`Failed to credit BranchFundBalance for branch ${branchId}`);
    }
    return result;
  }

  /**
   * Atomic, guarded decrement — the single most important method in this
   * module. The `availableAmount: { $gte: amountKobo }` filter is what makes
   * this safe under concurrent calls: MongoDB only matches (and therefore
   * only applies the $inc to) a document whose *current* balance can satisfy
   * the debit, and it evaluates that filter atomically as part of the same
   * operation that performs the decrement — there is no read-then-write
   * window for two concurrent debits to both observe "sufficient" and both
   * proceed. Do not "optimize" this into a separate findOne + updateOne.
   */
  async debit(
    branchId: string,
    amountKobo: number,
    session?: ClientSession,
  ): Promise<BranchFundBalanceDocument> {
    const result = await this.balanceModel
      .findOneAndUpdate(
        { branchId, availableAmount: { $gte: amountKobo } },
        { $inc: { availableAmount: -amountKobo }, $set: { updatedAt: new Date() } },
        { new: true, session },
      )
      .exec();
    if (!result) {
      throw new InsufficientBranchFundsException(branchId, amountKobo);
    }
    return result;
  }

  /** Zero for a branch with no funding history yet — never throws NotFound. */
  async getBalance(branchId: string): Promise<number> {
    const doc = await this.balanceModel.findOne({ branchId }).lean().exec();
    return doc?.availableAmount ?? 0;
  }
}
