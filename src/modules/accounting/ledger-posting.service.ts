import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';

import { AccountMappingKey, JournalSourceEvent } from '../../common/enums/accounting.enums';
import {
  LedgerPostingPort,
  PostDisbursementParams,
  PostedJournalEntry,
  PostFeeCollectionParams,
  PostPenaltyParams,
  PostRepaymentParams,
} from '../loans/interfaces/ledger-posting-port.interface';
import { AccountingService } from './accounting.service';
import { assertJournalLinesBalanced, JournalLineLike } from './journal-balance.util';
import { JournalEntry, JournalEntryDocument } from './schemas/journal-entry.schema';

/**
 * The real `LedgerPostingPort` implementation — see that interface's own
 * doc comment for why `session` is accepted but not nested into (every
 * posting here runs its own independently-managed session). See
 * PHASE_10_NOTES.md.
 */
@Injectable()
export class LedgerPostingService implements LedgerPostingPort {
  constructor(
    @InjectModel(JournalEntry.name) private readonly journalEntryModel: Model<JournalEntryDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly accountingService: AccountingService,
  ) {}

  async postDisbursement(
    params: PostDisbursementParams,
    _session?: ClientSession,
  ): Promise<PostedJournalEntry> {
    const [debitAccountId, creditAccountId] = await Promise.all([
      this.accountingService.resolveMappedAccountId(AccountMappingKey.DISBURSEMENT_DEBIT),
      this.accountingService.resolveMappedAccountId(AccountMappingKey.DISBURSEMENT_CREDIT),
    ]);
    return this.postIdempotent(
      JournalSourceEvent.LOAN_DISBURSEMENT,
      params.memberLoanAccountId,
      params.branchId,
      [
        { accountId: debitAccountId, debitKobo: params.amountKobo },
        { accountId: creditAccountId, creditKobo: params.amountKobo },
      ],
    );
  }

  async postFeeCollection(
    params: PostFeeCollectionParams,
    _session?: ClientSession,
  ): Promise<PostedJournalEntry> {
    const [debitAccountId, creditAccountId] = await Promise.all([
      this.accountingService.resolveMappedAccountId(AccountMappingKey.FEE_COLLECTION_DEBIT),
      this.accountingService.resolveMappedAccountId(AccountMappingKey.FEE_COLLECTION_CREDIT),
    ]);
    return this.postIdempotent(
      JournalSourceEvent.FEE_COLLECTION,
      params.feePaymentId,
      params.branchId,
      [
        { accountId: debitAccountId, debitKobo: params.amountKobo },
        { accountId: creditAccountId, creditKobo: params.amountKobo },
      ],
    );
  }

  async postRepayment(
    params: PostRepaymentParams,
    _session?: ClientSession,
  ): Promise<PostedJournalEntry> {
    const [debitAccountId, creditAccountId] = await Promise.all([
      this.accountingService.resolveMappedAccountId(AccountMappingKey.REPAYMENT_DEBIT),
      this.accountingService.resolveMappedAccountId(AccountMappingKey.REPAYMENT_CREDIT),
    ]);
    return this.postIdempotent(
      JournalSourceEvent.REPAYMENT,
      params.repaymentRecordId,
      params.branchId,
      [
        { accountId: debitAccountId, debitKobo: params.amountKobo },
        { accountId: creditAccountId, creditKobo: params.amountKobo },
      ],
    );
  }

  /**
   * Reused for both PenaltyCharge and LiquidationDelayCharge — both post as
   * `JournalSourceEvent.PENALTY` (the fixed JournalEntry-level category),
   * but `sourceRef` is built from `params.sourceEntityType` (the granular
   * `PENALTY_CHARGE`/`LIQUIDATION_DELAY_CHARGE` distinction), so the two
   * source collections can never collide even in the astronomically
   * unlikely event their ObjectIds ever matched.
   */
  async postPenalty(
    params: PostPenaltyParams,
    _session?: ClientSession,
  ): Promise<PostedJournalEntry> {
    const [debitAccountId, creditAccountId] = await Promise.all([
      this.accountingService.resolveMappedAccountId(AccountMappingKey.PENALTY_DEBIT),
      this.accountingService.resolveMappedAccountId(AccountMappingKey.PENALTY_CREDIT),
    ]);
    return this.postIdempotent(
      JournalSourceEvent.PENALTY,
      params.sourceEntityId,
      params.branchId,
      [
        { accountId: debitAccountId, debitKobo: params.amountKobo },
        { accountId: creditAccountId, creditKobo: params.amountKobo },
      ],
      { sourceRefPrefix: params.sourceEntityType },
    );
  }

  // ---------------------------------------------------------------------------
  // The shared idempotent-posting core
  // ---------------------------------------------------------------------------

  /**
   * `sourceRef = "{sourceRefPrefix ?? sourceEntityType}:{sourceEntityId}"` —
   * the idempotency key, enforced by a unique index on `JournalEntry.sourceRef`.
   *
   * 1. Balance validation (Σdebit === Σcredit) happens FIRST, unconditionally
   *    — an unbalanced entry is rejected before any DB access at all, not
   *    just before a write.
   * 2. Check for an existing entry with this `sourceRef`; if found, return it
   *    — a deliberate idempotent no-op, never an error.
   * 3. Otherwise insert, inside its own session/transaction. If a concurrent
   *    caller wins the race (unique-index violation), re-fetch and return
   *    THAT entry — never propagate the duplicate-key error as a failure.
   */
  private async postIdempotent(
    sourceEntityType: JournalSourceEvent,
    sourceEntityId: string,
    branchId: string,
    lines: JournalLineLike[],
    options: { sourceRefPrefix?: string } = {},
  ): Promise<PostedJournalEntry> {
    assertJournalLinesBalanced(lines);

    const sourceRef = `${options.sourceRefPrefix ?? sourceEntityType}:${sourceEntityId}`;

    const existing = await this.journalEntryModel.findOne({ sourceRef }).exec();
    if (existing) {
      return this.toPosted(existing);
    }

    const session = await this.connection.startSession();
    let createdEntry: JournalEntryDocument | null = null;
    try {
      await session.withTransaction(async () => {
        const created = await this.journalEntryModel.create(
          [
            {
              sourceEntityType,
              sourceEntityId: new Types.ObjectId(sourceEntityId),
              sourceRef,
              branchId: new Types.ObjectId(branchId),
              date: new Date(),
              lines: lines.map((line) => ({
                accountId: new Types.ObjectId(line.accountId),
                debitKobo: line.debitKobo ?? null,
                creditKobo: line.creditKobo ?? null,
              })),
              createdBy: null,
              postedBySystem: true,
              postedAt: new Date(),
            },
          ],
          { session, ordered: true },
        );
        createdEntry = created[0]!;
      });
    } catch (error) {
      await session.endSession();
      if (this.isDuplicateKeyError(error)) {
        // Lost the race — a concurrent caller's insert won. The unique
        // index is the final source of truth; re-fetch (a fresh,
        // non-transactional read — the session above is no longer usable
        // after a write error, see LedgerPostingPort's own doc comment) and
        // return the winner rather than propagating the failure.
        const winner = await this.journalEntryModel.findOne({ sourceRef }).exec();
        if (!winner) {
          throw new Error(
            `postIdempotent: duplicate key on sourceRef=${sourceRef} but no winning document found on re-fetch`,
          );
        }
        return this.toPosted(winner);
      }
      throw error;
    }
    await session.endSession();

    if (!createdEntry) {
      throw new Error(
        `postIdempotent: transaction for sourceRef=${sourceRef} completed without a result`,
      );
    }
    return this.toPosted(createdEntry);
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: number }).code === 11000
    );
  }

  private toPosted(entry: JournalEntryDocument): PostedJournalEntry {
    return {
      id: entry._id.toString(),
      sourceEntityType: entry.sourceEntityType,
      sourceEntityId: entry.sourceEntityId.toString(),
      sourceRef: entry.sourceRef,
      branchId: entry.branchId.toString(),
      date: entry.date,
      lines: entry.lines.map((line) => ({
        accountId: line.accountId.toString(),
        debitKobo: line.debitKobo ?? undefined,
        creditKobo: line.creditKobo ?? undefined,
      })),
      postedAt: entry.postedAt,
    };
  }
}
