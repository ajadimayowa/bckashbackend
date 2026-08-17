import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';

import { PenaltyFrequency, PenaltyPercentageBasis } from '../../common/enums/loan-product.enums';
import { MemberLoanAccountStatus } from '../../common/enums/loan.enums';
import { EarlyLiquidationStatus } from '../../common/enums/repayment.enums';
import {
  LEDGER_POSTING_PORT,
  LedgerPostingPort,
} from '../loans/interfaces/ledger-posting-port.interface';
import {
  NOTIFICATION_PORT,
  NotificationPort,
} from '../loans/interfaces/notification-port.interface';
import { calculatePenaltyAmount, PenaltyCalculationContext } from '../loan-products/calculations';
import { LoanProductsService } from '../loan-products/loan-products.service';
import {
  MemberLoanAccount,
  MemberLoanAccountDocument,
} from '../loans/schemas/member-loan-account.schema';
import { Loan, LoanDocument } from '../loans/schemas/loan.schema';
import { EarlyLiquidationService } from './early-liquidation.service';
import {
  EarlyLiquidationRequest,
  EarlyLiquidationRequestDocument,
} from './schemas/early-liquidation-request.schema';
import {
  LiquidationDelayCharge,
  LiquidationDelayChargeDocument,
} from './schemas/liquidation-delay-charge.schema';
import { PenaltyCharge, PenaltyChargeDocument } from './schemas/penalty-charge.schema';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface CappedAccountFlag {
  memberLoanAccountId: string;
  scheduleInstallmentNumber: number;
  periodIndex: number;
}

export interface CappedLiquidationFlag {
  liquidationRequestId: string;
  periodIndex: number;
}

export interface SweepResult {
  penaltyChargesApplied: number;
  liquidationDelayChargesApplied: number;
  /** Accounts whose penaltyRule.maxRecurrences cap was hit — see PHASE_9_NOTES.md ("log this state distinctly"). */
  accountsAtPenaltyCap: CappedAccountFlag[];
  /** Liquidation requests whose fee's maxRecurrences cap was hit. */
  liquidationsAtDelayChargeCap: CappedLiquidationFlag[];
}

/**
 * Daily BullMQ-scheduled job's actual logic (see `penalty-sweep.processor.ts`
 * for the thin BullMQ wrapper around this — kept separate deliberately so
 * this service's correctness can be tested by calling `runDailySweep`
 * directly, without needing a live Redis/BullMQ queue in the test suite; see
 * PHASE_9_NOTES.md).
 *
 * Two independent scans in one run (not two separate jobs — simpler to
 * schedule once, and they share nothing that would benefit from isolation):
 *   1. Every ACTIVE MemberLoanAccount's overdue schedule installments —
 *      ONE_TIME or RECURRING per `LoanProduct.penaltyRule.frequency`.
 *   2. Every APPROVED (not yet COMPLETED) EarlyLiquidationRequest whose
 *      linked EARLY_LIQUIDATION fee is configured RECURRING — the delay-
 *      charge mechanism, sharing the exact same idempotent period-index
 *      approach.
 */
@Injectable()
export class PenaltySweepService {
  private readonly logger = new Logger(PenaltySweepService.name);

  constructor(
    @InjectModel(MemberLoanAccount.name)
    private readonly memberLoanAccountModel: Model<MemberLoanAccountDocument>,
    @InjectModel(Loan.name) private readonly loanModel: Model<LoanDocument>,
    @InjectModel(PenaltyCharge.name)
    private readonly penaltyChargeModel: Model<PenaltyChargeDocument>,
    @InjectModel(EarlyLiquidationRequest.name)
    private readonly earlyLiquidationRequestModel: Model<EarlyLiquidationRequestDocument>,
    @InjectModel(LiquidationDelayCharge.name)
    private readonly liquidationDelayChargeModel: Model<LiquidationDelayChargeDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly loanProductsService: LoanProductsService,
    private readonly earlyLiquidationService: EarlyLiquidationService,
    @Inject(LEDGER_POSTING_PORT) private readonly ledgerPostingPort: LedgerPostingPort,
    @Inject(NOTIFICATION_PORT) private readonly notificationPort: NotificationPort,
  ) {}

  async runDailySweep(referenceDate: Date = new Date()): Promise<SweepResult> {
    const result: SweepResult = {
      penaltyChargesApplied: 0,
      liquidationDelayChargesApplied: 0,
      accountsAtPenaltyCap: [],
      liquidationsAtDelayChargeCap: [],
    };

    const activeAccounts = await this.memberLoanAccountModel
      .find({ status: MemberLoanAccountStatus.ACTIVE })
      .exec();
    for (const account of activeAccounts) {
      await this.sweepAccountPenalties(account, referenceDate, result);
    }

    const approvedLiquidations = await this.earlyLiquidationRequestModel
      .find({ status: EarlyLiquidationStatus.APPROVED })
      .exec();
    for (const liquidationRequest of approvedLiquidations) {
      await this.sweepLiquidationDelayCharge(liquidationRequest, referenceDate, result);
    }

    this.logger.log(
      `Penalty sweep complete: ${result.penaltyChargesApplied} penalty charge(s), ${result.liquidationDelayChargesApplied} liquidation delay charge(s) applied.`,
    );
    return result;
  }

  // ---------------------------------------------------------------------------
  // Overdue-installment penalties
  // ---------------------------------------------------------------------------

  private async sweepAccountPenalties(
    account: MemberLoanAccountDocument,
    referenceDate: Date,
    result: SweepResult,
  ): Promise<void> {
    const loan = await this.loanModel.findById(account.loanId).exec();
    if (!loan) {
      return; // defensive — should never happen, an account always has a loan
    }
    const product = await this.loanProductsService.findByIdOrThrow(loan.productId.toString());
    const penaltyRule = product.penaltyRule;

    const existingCharges = await this.penaltyChargeModel
      .find({ memberLoanAccountId: account._id })
      .exec();

    // FIFO reconciliation against the ORIGINAL schedule (see PHASE_9_NOTES.md
    // for why this is needed at all — MemberLoanAccount only tracks a single
    // aggregate outstandingBalanceKobo, not per-installment payment
    // allocation): nets out every penalty charged so far, isolating exactly
    // how much of the original principal+interest schedule has actually been
    // paid down by real repayments.
    const totalPenaltiesChargedKobo = existingCharges.reduce(
      (sum, c) => sum + c.penaltyAmountKobo,
      0,
    );
    const totalOriginalScheduledKobo = account.schedule.reduce((sum, e) => sum + e.totalDue, 0);
    const amountPaidTowardScheduleKobo =
      totalOriginalScheduledKobo +
      totalPenaltiesChargedKobo -
      (account.outstandingBalanceKobo ?? 0);

    let currentBalance = account.outstandingBalanceKobo ?? 0;
    let cumulativeDue = 0;

    // account.schedule is chronological (ascending installmentNumber/dueDate)
    // — once we reach a not-yet-due installment, none after it are due either.
    for (const installment of account.schedule) {
      cumulativeDue += installment.totalDue;
      const isUnpaid = cumulativeDue > amountPaidTowardScheduleKobo;
      if (!isUnpaid) {
        continue;
      }
      if (installment.dueDate > referenceDate) {
        break;
      }

      const daysLate = Math.floor(
        (referenceDate.getTime() - installment.dueDate.getTime()) / MS_PER_DAY,
      );
      if (daysLate <= penaltyRule.gracePeriodDays) {
        continue;
      }

      const periodIndex =
        penaltyRule.frequency === PenaltyFrequency.RECURRING
          ? Math.floor(
              (daysLate - penaltyRule.gracePeriodDays) /
                (penaltyRule.recurrenceIntervalDays as number),
            )
          : 0;

      if (
        penaltyRule.frequency === PenaltyFrequency.RECURRING &&
        penaltyRule.maxRecurrences !== null &&
        periodIndex >= penaltyRule.maxRecurrences
      ) {
        result.accountsAtPenaltyCap.push({
          memberLoanAccountId: account._id.toString(),
          scheduleInstallmentNumber: installment.installmentNumber,
          periodIndex,
        });
        continue;
      }

      const alreadyCharged = existingCharges.some(
        (c) =>
          c.scheduleInstallmentNumber === installment.installmentNumber &&
          c.periodIndex === periodIndex,
      );
      if (alreadyCharged) {
        continue;
      }

      const context: PenaltyCalculationContext = {
        overdueAmountKobo: installment.totalDue,
        outstandingBalanceKobo: currentBalance,
        principalKobo: account.principalAmountKobo,
      };
      const penaltyAmountKobo = calculatePenaltyAmount(penaltyRule, context, daysLate);
      if (penaltyAmountKobo <= 0) {
        continue;
      }

      const applied = await this.applyPenaltyCharge({
        memberLoanAccountId: account._id,
        scheduleInstallmentNumber: installment.installmentNumber,
        periodIndex,
        overdueAmountKobo: installment.totalDue,
        daysLateAtApplication: daysLate,
        penaltyAmountKobo,
        branchId: loan.branchId.toString(),
      });
      if (!applied) {
        continue; // lost a race against another sweep run — already charged.
      }

      currentBalance += penaltyAmountKobo;
      result.penaltyChargesApplied += 1;

      await this.notificationPort.sendPenaltyCharged(
        account.customerId.toString(),
        penaltyAmountKobo,
        penaltyRule.frequency === PenaltyFrequency.RECURRING
          ? `Installment ${installment.installmentNumber} recurring overdue penalty (period ${periodIndex})`
          : `Installment ${installment.installmentNumber} overdue penalty`,
      );
    }
  }

  /**
   * Atomic create-charge + increment-balance + ledger-post, guarded by the
   * unique (memberLoanAccountId, scheduleInstallmentNumber, periodIndex)
   * index — returns false (not applied) if a concurrent/prior run already
   * created this exact charge, so the caller never double-counts. This is
   * what makes the sweep safe to re-run at any point, including mid-crash
   * recovery.
   */
  private async applyPenaltyCharge(input: {
    memberLoanAccountId: Types.ObjectId;
    scheduleInstallmentNumber: number;
    periodIndex: number;
    overdueAmountKobo: number;
    daysLateAtApplication: number;
    penaltyAmountKobo: number;
    branchId: string;
  }): Promise<boolean> {
    const session = await this.connection.startSession();
    let applied = false;
    let chargeId: Types.ObjectId | null = null;
    try {
      await session.withTransaction(async () => {
        const exists = await this.penaltyChargeModel
          .exists({
            memberLoanAccountId: input.memberLoanAccountId,
            scheduleInstallmentNumber: input.scheduleInstallmentNumber,
            periodIndex: input.periodIndex,
          })
          .session(session);
        if (exists) {
          return;
        }

        const created = await this.penaltyChargeModel.create(
          [
            {
              memberLoanAccountId: input.memberLoanAccountId,
              scheduleInstallmentNumber: input.scheduleInstallmentNumber,
              periodIndex: input.periodIndex,
              overdueAmountKobo: input.overdueAmountKobo,
              daysLateAtApplication: input.daysLateAtApplication,
              penaltyAmountKobo: input.penaltyAmountKobo,
              appliedAt: new Date(),
            },
          ],
          { session, ordered: true },
        );
        const chargeDoc = created[0]!;

        await this.memberLoanAccountModel
          .updateOne(
            { _id: input.memberLoanAccountId },
            { $inc: { outstandingBalanceKobo: input.penaltyAmountKobo } },
            { session },
          )
          .exec();

        chargeId = chargeDoc._id;
        applied = true;
      });
    } catch (error) {
      if (this.isDuplicateKeyError(error)) {
        // Lost a race against another run inserting the exact same
        // (account, installment, period) between our exists-check and our
        // insert — the unique index is the ultimate source of truth here.
        return false;
      }
      throw error;
    } finally {
      await session.endSession();
    }

    // Ledger posting happens AFTER this transaction commits, deliberately
    // outside any session — see PHASE_10_NOTES.md. Nesting
    // LedgerPostingService's own independently-managed session inside this
    // still-open transaction (both on the same connection) is exactly what
    // caused a genuine, reproducible deadlock during full-suite testing.
    // The write was never atomic with this transaction to begin with (the
    // passed-in session was never actually used for it), so posting after
    // commit changes nothing about the atomicity guarantee.
    if (applied && chargeId) {
      try {
        await this.ledgerPostingPort.postPenalty({
          sourceEntityType: 'PENALTY_CHARGE',
          sourceEntityId: (chargeId as Types.ObjectId).toString(),
          amountKobo: input.penaltyAmountKobo,
          branchId: input.branchId,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Ledger posting failed for PenaltyCharge ${(chargeId as Types.ObjectId).toString()}: ${message}`,
        );
      }
    }
    return applied;
  }

  // ---------------------------------------------------------------------------
  // Early-liquidation recurring delay charges
  // ---------------------------------------------------------------------------

  private async sweepLiquidationDelayCharge(
    liquidationRequest: EarlyLiquidationRequestDocument,
    referenceDate: Date,
    result: SweepResult,
  ): Promise<void> {
    if (!liquidationRequest.approvedAt) {
      return; // defensive — status APPROVED should always have approvedAt set
    }

    const account = await this.memberLoanAccountModel
      .findById(liquidationRequest.memberLoanAccountId)
      .exec();
    if (!account) {
      return;
    }
    const loan = await this.loanModel.findById(account.loanId).exec();
    if (!loan) {
      return;
    }
    const fee = await this.earlyLiquidationService.findEarlyLiquidationFee(
      loan.productId.toString(),
    );

    // ONE_TIME: already fully captured in totalPayableKobo at request time — nothing further to do here.
    if (fee.frequency !== PenaltyFrequency.RECURRING) {
      return;
    }

    const daysSinceApproval = Math.floor(
      (referenceDate.getTime() - liquidationRequest.approvedAt.getTime()) / MS_PER_DAY,
    );
    // ASSUMPTION (flagged, see PHASE_9_NOTES.md — genuinely open question, the
    // brief never described a liquidation-specific grace period): reuses
    // `approvedAt` as day zero with NO additional grace — delay charges can
    // start accruing from day 1 of non-payment. `daysSinceApproval < 1` (i.e.
    // the approval day itself) never charges; period 0 covers days
    // [1, recurrenceIntervalDays], mirroring the penalty sweep's own
    // `daysLate - gracePeriodDays` shape with an effective grace of 0.
    if (daysSinceApproval < 1) {
      return;
    }
    const periodIndex = Math.floor(
      (daysSinceApproval - 1) / (fee.recurrenceIntervalDays as number),
    );

    if (fee.maxRecurrences !== null && periodIndex >= fee.maxRecurrences) {
      result.liquidationsAtDelayChargeCap.push({
        liquidationRequestId: liquidationRequest._id.toString(),
        periodIndex,
      });
      return;
    }

    const alreadyCharged = await this.liquidationDelayChargeModel
      .exists({ liquidationRequestId: liquidationRequest._id, periodIndex })
      .exec();
    if (alreadyCharged) {
      return;
    }

    // fee.percentageOf (FeePercentageBasis) and PenaltyPercentageBasis are
    // deliberately kept as identical string unions (PRINCIPAL/OUTSTANDING/
    // OVERDUE_AMOUNT) specifically so this cast is safe — see
    // loan-product.enums.ts. `overdueAmountKobo` maps to the liquidation's
    // own "amount owed" concept (totalPayableKobo), since there's no
    // schedule installment involved here.
    const penaltyRuleLike = {
      calcType: fee.calcType,
      value: fee.value,
      percentageOf: fee.percentageOf as unknown as PenaltyPercentageBasis,
      gracePeriodDays: 0,
    };
    const context: PenaltyCalculationContext = {
      overdueAmountKobo: liquidationRequest.totalPayableKobo,
      outstandingBalanceKobo: account.outstandingBalanceKobo ?? 0,
      principalKobo: account.principalAmountKobo,
    };
    // daysLate=1 here only to clear the (already-satisfied-by-us) grace
    // check inside calculatePenaltyAmount — the real gating already happened
    // above via daysSinceApproval.
    const chargeAmountKobo = calculatePenaltyAmount(penaltyRuleLike, context, 1);
    if (chargeAmountKobo <= 0) {
      return;
    }

    const applied = await this.applyLiquidationDelayCharge({
      liquidationRequestId: liquidationRequest._id,
      periodIndex,
      chargeAmountKobo,
      branchId: loan.branchId.toString(),
    });
    if (!applied) {
      return;
    }

    result.liquidationDelayChargesApplied += 1;
    await this.notificationPort.sendPenaltyCharged(
      account.customerId.toString(),
      chargeAmountKobo,
      `Early liquidation delay charge (period ${periodIndex})`,
    );
  }

  /** Same atomic create+increment+post+idempotency-guard shape as applyPenaltyCharge, scoped to totalPayableKobo instead of the account balance. */
  private async applyLiquidationDelayCharge(input: {
    liquidationRequestId: Types.ObjectId;
    periodIndex: number;
    chargeAmountKobo: number;
    branchId: string;
  }): Promise<boolean> {
    const session = await this.connection.startSession();
    let applied = false;
    let chargeId: Types.ObjectId | null = null;
    try {
      await session.withTransaction(async () => {
        const exists = await this.liquidationDelayChargeModel
          .exists({
            liquidationRequestId: input.liquidationRequestId,
            periodIndex: input.periodIndex,
          })
          .session(session);
        if (exists) {
          return;
        }

        const created = await this.liquidationDelayChargeModel.create(
          [
            {
              liquidationRequestId: input.liquidationRequestId,
              periodIndex: input.periodIndex,
              chargeAmountKobo: input.chargeAmountKobo,
              appliedAt: new Date(),
            },
          ],
          { session, ordered: true },
        );
        const chargeDoc = created[0]!;

        await this.earlyLiquidationRequestModel
          .updateOne(
            { _id: input.liquidationRequestId },
            { $inc: { totalPayableKobo: input.chargeAmountKobo } },
            { session },
          )
          .exec();

        chargeId = chargeDoc._id;
        applied = true;
      });
    } catch (error) {
      if (this.isDuplicateKeyError(error)) {
        return false;
      }
      throw error;
    } finally {
      await session.endSession();
    }

    // Ledger posting after commit, outside any session — same reasoning as
    // applyPenaltyCharge above; see PHASE_10_NOTES.md. Reuses postPenalty —
    // a delay charge is functionally a penalty. See LedgerPostingPort's own
    // doc comment.
    if (applied && chargeId) {
      try {
        await this.ledgerPostingPort.postPenalty({
          sourceEntityType: 'LIQUIDATION_DELAY_CHARGE',
          sourceEntityId: (chargeId as Types.ObjectId).toString(),
          amountKobo: input.chargeAmountKobo,
          branchId: input.branchId,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Ledger posting failed for LiquidationDelayCharge ${(chargeId as Types.ObjectId).toString()}: ${message}`,
        );
      }
    }
    return applied;
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: number }).code === 11000
    );
  }
}
