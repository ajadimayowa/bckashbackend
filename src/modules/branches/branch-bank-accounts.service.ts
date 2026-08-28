import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { CreateBranchBankAccountDto } from './dto/create-branch-bank-account.dto';
import { UpdateBranchBankAccountDto } from './dto/update-branch-bank-account.dto';
import { BranchBankAccount, BranchBankAccountDocument } from './schemas/branch-bank-account.schema';

const DUPLICATE_KEY_ERROR_CODE = 11000;

/**
 * A branch may have many bank accounts, but at most one is ever `active` at
 * a time — that's the one `BranchFundingService.recordFunding` requires a
 * funding record to target (see its own doc comment). Activating one
 * deactivates whichever other account currently holds that spot, in the
 * same write where possible; nothing here ever *requires* an active account
 * to exist (a branch can legitimately have zero, right after creation).
 */
@Injectable()
export class BranchBankAccountsService {
  constructor(
    @InjectModel(BranchBankAccount.name)
    private readonly bankAccountModel: Model<BranchBankAccountDocument>,
  ) {}

  async create(dto: CreateBranchBankAccountDto): Promise<BranchBankAccountDocument> {
    const branchObjectId = new Types.ObjectId(dto.branchId);
    const existingCount = await this.bankAccountModel.countDocuments({ branchId: branchObjectId }).exec();
    // The branch's first account has nothing to be exclusive *of* — make it
    // active automatically so funding isn't blocked on a separate "now make
    // one active" step immediately after adding the only account that could
    // possibly hold that spot.
    const shouldBeActive = dto.active ?? existingCount === 0;

    if (shouldBeActive) {
      await this.deactivateOthers(branchObjectId);
    }

    try {
      return await this.bankAccountModel.create({
        branchId: branchObjectId,
        bankName: dto.bankName,
        accountNumber: dto.accountNumber,
        accountName: dto.accountName,
        purpose: dto.purpose,
        active: shouldBeActive,
      });
    } catch (err) {
      this.rethrowDuplicateKeyAsConflict(err, dto.bankName, dto.accountNumber);
    }
  }

  async findAll(branchId?: string, active?: boolean): Promise<BranchBankAccountDocument[]> {
    const filter: Record<string, unknown> = {};
    if (branchId) filter.branchId = new Types.ObjectId(branchId);
    if (active !== undefined) filter.active = active;
    return this.bankAccountModel.find(filter).sort({ createdAt: -1 }).exec();
  }

  async findById(id: string): Promise<BranchBankAccountDocument> {
    const account = await this.bankAccountModel.findById(id).exec();
    if (!account) {
      throw new NotFoundException(`BranchBankAccount ${id} not found`);
    }
    return account;
  }

  /**
   * No delete endpoint — retiring an account is `PATCH { active: false }`.
   * See PHASE_4_NOTES.md for why a hard delete (even a conditional one)
   * isn't built in this phase. Setting `active: true` deactivates whichever
   * other account for the same branch currently holds that spot first.
   */
  async update(id: string, dto: UpdateBranchBankAccountDto): Promise<BranchBankAccountDocument> {
    const existing = await this.findById(id);

    if (dto.active === true) {
      await this.deactivateOthers(existing.branchId, existing._id);
    }

    let account: BranchBankAccountDocument | null;
    try {
      account = await this.bankAccountModel.findByIdAndUpdate(id, { $set: dto }, { new: true }).exec();
    } catch (err) {
      this.rethrowDuplicateKeyAsConflict(err, dto.bankName, dto.accountNumber);
    }
    if (!account) {
      throw new NotFoundException(`BranchBankAccount ${id} not found`);
    }
    return account;
  }

  /** The branch's currently-active account, if any — what BranchFundingService validates a funding record's bankAccountId against. */
  async findActiveForBranch(branchId: string): Promise<BranchBankAccountDocument | null> {
    return this.bankAccountModel.findOne({ branchId: new Types.ObjectId(branchId), active: true }).exec();
  }

  private async deactivateOthers(branchId: Types.ObjectId, excludeId?: Types.ObjectId): Promise<void> {
    const filter: Record<string, unknown> = { branchId, active: true };
    if (excludeId) {
      filter._id = { $ne: excludeId };
    }
    await this.bankAccountModel.updateMany(filter, { $set: { active: false } }).exec();
  }

  /**
   * Duck-typed on `err.code`, not `instanceof MongoServerError` — mongoose
   * vendors its own nested copy of the `mongodb` driver, which can end up as
   * a different module instance than one imported directly at this package's
   * top level, making `instanceof` unreliable here. `code` is a plain number
   * on the wire-protocol error and is stable regardless of which copy of the
   * driver class constructed the object.
   */
  private rethrowDuplicateKeyAsConflict(
    err: unknown,
    bankName?: string,
    accountNumber?: string,
  ): never {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === DUPLICATE_KEY_ERROR_CODE) {
      throw new ConflictException(
        `A bank account with bankName "${bankName}" and accountNumber "${accountNumber}" is already registered`,
      );
    }
    throw err;
  }
}
