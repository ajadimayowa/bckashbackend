import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';

import { BRANCH_CREATED_EVENT, BranchCreatedEvent } from './events/branch.events';
import { InsufficientBranchFundsException } from './exceptions/insufficient-branch-funds.exception';
import { BranchFundBalance, BranchFundBalanceDocument } from './schemas/branch-fund-balance.schema';

/**
 * The fund-balance primitive Phase 8's disbursement flow depends on.
 * `credit`/`debit` both accept an optional Mongo `session` so callers can
 * compose the balance change into a larger multi-document transaction
 * (funding verification here; disbursement + loan status + ledger entry in
 * Phase 8) — see PHASE_4_NOTES.md.
 *
 * *** BUG FOUND AND FIXED IN PHASE 8 — SEE PHASE_8_NOTES.md ***
 * Every method below now explicitly casts `branchId` to `Types.ObjectId` in
 * its query filter/write payload — this file previously passed the plain
 * `branchId` string straight through. That is the exact same family of bug
 * documented for `KycRecord.customerId` in Phase 5 and for write-side
 * `Model.create()` calls in Phase 6: a plain string filtered/written against
 * a non-`_id` ObjectId-typed path does not reliably cast in this codebase's
 * Mongoose setup. It went undetected by this module's own Phase 4 tests only
 * because `handleBranchCreated`'s `$setOnInsert` also stored the uncast
 * plain-string value — so every read/write in that one flow consistently
 * used strings and coincidentally matched each other. Phase 8 hit it for
 * real: a `BranchFundBalance` document created directly with a genuine
 * `Types.ObjectId` `branchId` (as any spec/service outside this one
 * self-consistent flow would do) was invisible to `getBalance`/`debit`,
 * making every disbursement fail with a false
 * `InsufficientBranchFundsException` regardless of actual balance —
 * reproduced empirically while building `LoanVerificationService`.
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
    const branchId = new Types.ObjectId(event.branchId);
    await this.balanceModel
      .updateOne({ branchId }, { $setOnInsert: { branchId, availableAmount: 0 } }, { upsert: true })
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
        { branchId: new Types.ObjectId(branchId) },
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
        { branchId: new Types.ObjectId(branchId), availableAmount: { $gte: amountKobo } },
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
    const doc = await this.balanceModel
      .findOne({ branchId: new Types.ObjectId(branchId) })
      .lean()
      .exec();
    return doc?.availableAmount ?? 0;
  }
}
