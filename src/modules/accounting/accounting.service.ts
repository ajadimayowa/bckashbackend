import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { AccountMappingKey, AccountType } from '../../common/enums/accounting.enums';
import { compactFilter } from '../../common/utils/compact-filter.util';
import { AccountMapping, AccountMappingDocument } from './schemas/account-mapping.schema';
import { Account, AccountDocument } from './schemas/account.schema';
import { JournalEntry, JournalEntryDocument } from './schemas/journal-entry.schema';

/** ASSET/EXPENSE accounts normally carry a debit balance; LIABILITY/EQUITY/INCOME normally carry a credit balance. */
function isNormalDebitBalance(type: AccountType): boolean {
  return type === AccountType.ASSET || type === AccountType.EXPENSE;
}

export interface AccountBalanceRow {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  /** Signed per the account's normal-balance convention — never a raw debit-minus-credit that reads negative for a healthy account. */
  balanceKobo: number;
}

export interface TrialBalance {
  accounts: AccountBalanceRow[];
  totalDebitKobo: number;
  totalCreditKobo: number;
  balanced: boolean;
}

export interface LedgerEntriesPage {
  entries: JournalEntryDocument[];
  total: number;
  page: number;
  pageSize: number;
}

export interface GetLedgerEntriesOptions {
  from?: Date;
  to?: Date;
  branchId?: string;
  page?: number;
  pageSize?: number;
}

export interface CreateAccountInput {
  code: string;
  name: string;
  type: AccountType;
  parentAccountId?: string;
}

export interface UpdateAccountInput {
  name?: string;
  parentAccountId?: string | null;
  active?: boolean;
}

interface DefaultAccountSeed {
  code: string;
  name: string;
  type: AccountType;
}

/**
 * Build what the automated postings in `LedgerPostingService` actually need
 * — deliberately not a full general chart of accounts. Six accounts, per
 * the brief's own list. `Penalty Receivable` is kept SEPARATE from `Loans
 * Receivable` (the brief left this as "your call, document it") — a penalty
 * accrual is a distinct, useful-to-track-separately receivable from the
 * original principal+interest, matching common practice for late-fee
 * reporting/reconciliation. `Interest Income` is seeded per the brief's own
 * list but note: no automated posting in this phase actually credits it —
 * the brief's own §2 mapping never splits interest recognition out of
 * `Loans Receivable` (a repayment simply shrinks the receivable uniformly).
 * It exists as a ready target for a manual entry or a future refinement —
 * flagged explicitly in PHASE_10_NOTES.md, not silently omitted.
 */
const DEFAULT_ACCOUNTS: readonly DefaultAccountSeed[] = [
  { code: '1010', name: 'Cash/Bank — Branch Operations', type: AccountType.ASSET },
  { code: '1020', name: 'Loans Receivable', type: AccountType.ASSET },
  { code: '1030', name: 'Penalty Receivable', type: AccountType.ASSET },
  { code: '4010', name: 'Fee Income', type: AccountType.INCOME },
  { code: '4020', name: 'Interest Income', type: AccountType.INCOME },
  { code: '4030', name: 'Penalty Income', type: AccountType.INCOME },
];

/**
 * Default account mapping — see PHASE_10_NOTES.md for the full reasoning,
 * and the brief's own explicit request for a real accountant's sign-off
 * before this is treated as final:
 *   - Disbursement: Dr Loans Receivable, Cr Cash/Bank (money leaves the
 *     branch fund, becomes a receivable).
 *   - Repayment: Dr Cash/Bank, Cr Loans Receivable (money returns,
 *     receivable shrinks).
 *   - Fee collection: Dr Cash/Bank, Cr Fee Income.
 *   - Penalty (both PenaltyCharge and LiquidationDelayCharge): Dr Penalty
 *     Receivable, Cr Penalty Income.
 */
const DEFAULT_MAPPING: Readonly<Record<AccountMappingKey, string>> = {
  [AccountMappingKey.DISBURSEMENT_DEBIT]: '1020',
  [AccountMappingKey.DISBURSEMENT_CREDIT]: '1010',
  [AccountMappingKey.REPAYMENT_DEBIT]: '1010',
  [AccountMappingKey.REPAYMENT_CREDIT]: '1020',
  [AccountMappingKey.FEE_COLLECTION_DEBIT]: '1010',
  [AccountMappingKey.FEE_COLLECTION_CREDIT]: '4010',
  [AccountMappingKey.PENALTY_DEBIT]: '1030',
  [AccountMappingKey.PENALTY_CREDIT]: '4030',
};

@Injectable()
export class AccountingService implements OnModuleInit {
  constructor(
    @InjectModel(Account.name) private readonly accountModel: Model<AccountDocument>,
    @InjectModel(AccountMapping.name)
    private readonly accountMappingModel: Model<AccountMappingDocument>,
    @InjectModel(JournalEntry.name) private readonly journalEntryModel: Model<JournalEntryDocument>,
  ) {}

  /**
   * Idempotent — `$setOnInsert` on both accounts (by `code`) and mappings
   * (by `key`), so an Admin's later edits (via the CRUD/mapping-update
   * methods below) are never clobbered by a redeploy. Same pattern as
   * `RbacService`'s role-capability seeding.
   */
  async onModuleInit(): Promise<void> {
    const accountsByCode = new Map<string, AccountDocument>();
    for (const seed of DEFAULT_ACCOUNTS) {
      const doc = await this.accountModel
        .findOneAndUpdate(
          { code: seed.code },
          { $setOnInsert: { code: seed.code, name: seed.name, type: seed.type, active: true } },
          { upsert: true, new: true },
        )
        .exec();
      accountsByCode.set(seed.code, doc);
    }

    for (const [key, code] of Object.entries(DEFAULT_MAPPING) as [AccountMappingKey, string][]) {
      const account = accountsByCode.get(code);
      if (!account) {
        // Unreachable — every DEFAULT_MAPPING value references a DEFAULT_ACCOUNTS code.
        throw new Error(
          `AccountingService seed misconfigured: no default account for code ${code}`,
        );
      }
      await this.accountMappingModel
        .updateOne({ key }, { $setOnInsert: { key, accountId: account._id } }, { upsert: true })
        .exec();
    }
  }

  // ---------------------------------------------------------------------------
  // Chart of accounts CRUD
  // ---------------------------------------------------------------------------

  async createAccount(input: CreateAccountInput): Promise<AccountDocument> {
    if (input.parentAccountId) {
      await this.findAccountByIdOrThrow(input.parentAccountId);
    }
    try {
      return await this.accountModel.create({
        code: input.code,
        name: input.name,
        type: input.type,
        parentAccountId: input.parentAccountId ? new Types.ObjectId(input.parentAccountId) : null,
        active: true,
      });
    } catch (error) {
      if (this.isDuplicateKeyError(error)) {
        throw new BadRequestException(`Account code "${input.code}" already exists`);
      }
      throw error;
    }
  }

  async updateAccount(accountId: string, input: UpdateAccountInput): Promise<AccountDocument> {
    await this.findAccountByIdOrThrow(accountId);
    if (input.parentAccountId) {
      await this.findAccountByIdOrThrow(input.parentAccountId);
    }

    const setFields: Record<string, unknown> = {};
    if (input.name !== undefined) {
      setFields.name = input.name;
    }
    if (input.parentAccountId !== undefined) {
      setFields.parentAccountId = input.parentAccountId
        ? new Types.ObjectId(input.parentAccountId)
        : null;
    }
    if (input.active !== undefined) {
      setFields.active = input.active;
    }

    const updated = await this.accountModel
      .findByIdAndUpdate(accountId, { $set: setFields }, { new: true })
      .exec();
    if (!updated) {
      throw new NotFoundException(`Account ${accountId} not found`);
    }
    return updated;
  }

  async findAccountByIdOrThrow(accountId: string): Promise<AccountDocument> {
    const account = await this.accountModel.findById(accountId).exec();
    if (!account) {
      throw new NotFoundException(`Account ${accountId} not found`);
    }
    return account;
  }

  async findAllAccounts(
    filter: { type?: AccountType; active?: boolean } = {},
  ): Promise<AccountDocument[]> {
    // See compactFilter's own doc comment — an absent `?type=`/`?active=`
    // query param comes through as `undefined`, and Mongoose treats
    // `{ type: undefined }` as an actual (never-true) constraint, not "no
    // filter" — this silently returned `[]` for GET /accounting/accounts
    // whenever called without both filters.
    return this.accountModel.find(compactFilter(filter)).sort({ code: 1 }).exec();
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
  // Account mapping
  // ---------------------------------------------------------------------------

  /** Used internally by LedgerPostingService — throws (not a silent default) if a key was somehow never seeded/configured. */
  async resolveMappedAccountId(key: AccountMappingKey): Promise<string> {
    const mapping = await this.accountMappingModel.findOne({ key }).exec();
    if (!mapping) {
      throw new NotFoundException(`No AccountMapping configured for key ${key}`);
    }
    return mapping.accountId.toString();
  }

  async setMapping(key: AccountMappingKey, accountId: string): Promise<AccountMappingDocument> {
    await this.findAccountByIdOrThrow(accountId);
    const updated = await this.accountMappingModel
      .findOneAndUpdate(
        { key },
        { $set: { accountId: new Types.ObjectId(accountId) } },
        { new: true, upsert: true },
      )
      .exec();
    if (!updated) {
      throw new Error(`Failed to upsert AccountMapping for key ${key}`);
    }
    return updated;
  }

  async listMappings(): Promise<AccountMappingDocument[]> {
    return this.accountMappingModel.find().sort({ key: 1 }).exec();
  }

  // ---------------------------------------------------------------------------
  // Read surface
  // ---------------------------------------------------------------------------

  /**
   * Signed per the account's normal-balance convention (see
   * `isNormalDebitBalance`) — an ASSET/EXPENSE account's balance is
   * debit-minus-credit; a LIABILITY/EQUITY/INCOME account's balance is
   * credit-minus-debit. A raw, unsigned debit-minus-credit would read as
   * negative for a perfectly healthy INCOME account, which is not useful.
   */
  async getAccountBalance(accountId: string, asOfDate?: Date): Promise<number> {
    const account = await this.findAccountByIdOrThrow(accountId);
    const { totalDebitKobo, totalCreditKobo } = await this.sumLinesForAccount(accountId, asOfDate);
    return isNormalDebitBalance(account.type)
      ? totalDebitKobo - totalCreditKobo
      : totalCreditKobo - totalDebitKobo;
  }

  private async sumLinesForAccount(
    accountId: string,
    asOfDate?: Date,
    branchId?: string,
  ): Promise<{ totalDebitKobo: number; totalCreditKobo: number }> {
    const match: Record<string, unknown> = { 'lines.accountId': new Types.ObjectId(accountId) };
    if (asOfDate) {
      match.date = { $lte: asOfDate };
    }
    if (branchId) {
      match.branchId = new Types.ObjectId(branchId);
    }

    const result = await this.journalEntryModel
      .aggregate<{ totalDebitKobo: number; totalCreditKobo: number }>([
        { $match: match },
        { $unwind: '$lines' },
        { $match: { 'lines.accountId': new Types.ObjectId(accountId) } },
        {
          $group: {
            _id: null,
            totalDebitKobo: { $sum: { $ifNull: ['$lines.debitKobo', 0] } },
            totalCreditKobo: { $sum: { $ifNull: ['$lines.creditKobo', 0] } },
          },
        },
      ])
      .exec();

    return {
      totalDebitKobo: result[0]?.totalDebitKobo ?? 0,
      totalCreditKobo: result[0]?.totalCreditKobo ?? 0,
    };
  }

  /**
   * Every account with its (correctly signed) balance, plus the raw
   * debit/credit totals across the whole ledger — `balanced` confirms
   * total debits equal total credits system-wide, a genuine sanity check
   * that would catch any bug letting an unbalanced entry slip through
   * `LedgerPostingService`'s validation.
   */
  async getTrialBalance(asOfDate?: Date, branchId?: string): Promise<TrialBalance> {
    const accounts = await this.accountModel.find().sort({ code: 1 }).exec();

    const rows: AccountBalanceRow[] = [];
    let totalDebitKobo = 0;
    let totalCreditKobo = 0;

    for (const account of accounts) {
      const sums = await this.sumLinesForAccount(account._id.toString(), asOfDate, branchId);
      totalDebitKobo += sums.totalDebitKobo;
      totalCreditKobo += sums.totalCreditKobo;
      rows.push({
        accountId: account._id.toString(),
        code: account.code,
        name: account.name,
        type: account.type,
        balanceKobo: isNormalDebitBalance(account.type)
          ? sums.totalDebitKobo - sums.totalCreditKobo
          : sums.totalCreditKobo - sums.totalDebitKobo,
      });
    }

    return {
      accounts: rows,
      totalDebitKobo,
      totalCreditKobo,
      balanced: totalDebitKobo === totalCreditKobo,
    };
  }

  /** Paginated entry list for an account, for reconciliation/audit use. */
  async getLedgerEntries(
    accountId: string,
    options: GetLedgerEntriesOptions = {},
  ): Promise<LedgerEntriesPage> {
    const filter: Record<string, unknown> = { 'lines.accountId': new Types.ObjectId(accountId) };
    if (options.branchId) {
      filter.branchId = new Types.ObjectId(options.branchId);
    }
    if (options.from || options.to) {
      const dateFilter: Record<string, Date> = {};
      if (options.from) {
        dateFilter.$gte = options.from;
      }
      if (options.to) {
        dateFilter.$lte = options.to;
      }
      filter.date = dateFilter;
    }

    const page = options.page && options.page > 0 ? options.page : 1;
    const pageSize = options.pageSize && options.pageSize > 0 ? options.pageSize : 50;

    const [entries, total] = await Promise.all([
      this.journalEntryModel
        .find(filter)
        .sort({ date: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .exec(),
      this.journalEntryModel.countDocuments(filter).exec(),
    ]);

    return { entries, total, page, pageSize };
  }
}
