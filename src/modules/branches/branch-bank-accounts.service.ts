import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { CreateBranchBankAccountDto } from './dto/create-branch-bank-account.dto';
import { UpdateBranchBankAccountDto } from './dto/update-branch-bank-account.dto';
import { BranchBankAccount, BranchBankAccountDocument } from './schemas/branch-bank-account.schema';

const DUPLICATE_KEY_ERROR_CODE = 11000;

@Injectable()
export class BranchBankAccountsService {
  constructor(
    @InjectModel(BranchBankAccount.name)
    private readonly bankAccountModel: Model<BranchBankAccountDocument>,
  ) {}

  async create(dto: CreateBranchBankAccountDto): Promise<BranchBankAccountDocument> {
    try {
      return await this.bankAccountModel.create({
        branchId: dto.branchId,
        bankName: dto.bankName,
        accountNumber: dto.accountNumber,
        accountName: dto.accountName,
        purpose: dto.purpose,
        active: true,
      });
    } catch (err) {
      this.rethrowDuplicateKeyAsConflict(err, dto.bankName, dto.accountNumber);
    }
  }

  async findAll(branchId?: string): Promise<BranchBankAccountDocument[]> {
    const filter = branchId ? { branchId } : {};
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
   * See PHASE_4_NOTES.md for why a hard delete (even a conditional one) isn't
   * built in this phase.
   */
  async update(id: string, dto: UpdateBranchBankAccountDto): Promise<BranchBankAccountDocument> {
    let account: BranchBankAccountDocument | null;
    try {
      account = await this.bankAccountModel
        .findByIdAndUpdate(id, { $set: dto }, { new: true })
        .exec();
    } catch (err) {
      this.rethrowDuplicateKeyAsConflict(err, dto.bankName, dto.accountNumber);
    }
    if (!account) {
      throw new NotFoundException(`BranchBankAccount ${id} not found`);
    }
    return account;
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
