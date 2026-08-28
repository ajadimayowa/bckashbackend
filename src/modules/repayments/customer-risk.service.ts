import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import {
  CHEQUE_PICKUP_PENALTY_GRACE_BUFFER_DAYS,
  DisbursementChannel,
  MemberLoanAccountStatus,
} from '../../common/enums/loan.enums';
import { LoanProductsService } from '../loan-products/loan-products.service';
import { Loan, LoanDocument } from '../loans/schemas/loan.schema';
import {
  MemberLoanAccount,
  MemberLoanAccountDocument,
} from '../loans/schemas/member-loan-account.schema';
import { PenaltyCharge, PenaltyChargeDocument } from './schemas/penalty-charge.schema';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type CustomerRepaymentRiskFlag = 'NONE' | 'AMBER' | 'RED';

export interface CustomerRepaymentRiskSummary {
  flag: CustomerRepaymentRiskFlag;
  /** Days past the (CHEQUE_PICKUP-buffered) grace period the worst overdue installment is at. Null when flag is NONE. */
  daysPastGrace: number | null;
  /** The MemberLoanAccount driving the worst-case flag, if any. */
  memberLoanAccountId: string | null;
  message: string | null;
}

/**
 * Live (not sweep-dependent) "is this customer currently behind on
 * repayments" read for the Customer Detail page's warning banner — reuses
 * the same FIFO-against-the-original-schedule reconciliation
 * PenaltySweepService.sweepAccountPenalties uses to find the oldest unpaid
 * overdue installment (see that method's own doc comment for why the FIFO
 * walk is needed at all: MemberLoanAccount only tracks one aggregate
 * outstandingBalanceKobo, not a per-installment paid amount).
 *
 * Deliberately a SEPARATE, read-only re-implementation rather than an
 * extraction shared with the sweep's already-tested loop — this method never
 * charges a penalty or mutates anything, so today's answer never waits on
 * tonight's sweep having already run; the ~15 lines of overlap were judged
 * not worth the regression risk of refactoring the sweep's carefully-tuned
 * loop to share code with a brand-new consumer.
 *
 * Tiers (a flagged policy default — the brief asked for "give a code amber,
 * red" as the customer's lateness worsens, not exact thresholds):
 *   NONE  — every ACTIVE account is current, or overdue only within grace.
 *   AMBER — at least one account has an unpaid installment overdue past
 *           grace, but by less than one full `repaymentPeriodDays` cycle —
 *           the customer's first missed cycle.
 *   RED   — the worst overdue installment is more than one full
 *           `repaymentPeriodDays` cycle past grace — the customer has missed
 *           more than one repayment cycle outright.
 */
@Injectable()
export class CustomerRiskService {
  constructor(
    @InjectModel(MemberLoanAccount.name)
    private readonly memberLoanAccountModel: Model<MemberLoanAccountDocument>,
    @InjectModel(Loan.name) private readonly loanModel: Model<LoanDocument>,
    @InjectModel(PenaltyCharge.name)
    private readonly penaltyChargeModel: Model<PenaltyChargeDocument>,
    private readonly loanProductsService: LoanProductsService,
  ) {}

  async getRepaymentRisk(
    customerId: string,
    referenceDate: Date = new Date(),
  ): Promise<CustomerRepaymentRiskSummary> {
    const accounts = await this.memberLoanAccountModel
      .find({
        customerId: new Types.ObjectId(customerId),
        status: MemberLoanAccountStatus.ACTIVE,
      })
      .exec();

    let worst: { daysPastGrace: number; account: MemberLoanAccountDocument } | null = null;
    for (const account of accounts) {
      const overdue = await this.worstOverdueForAccount(account, referenceDate);
      if (overdue && (!worst || overdue.daysPastGrace > worst.daysPastGrace)) {
        worst = { daysPastGrace: overdue.daysPastGrace, account };
      }
    }

    if (!worst) {
      return { flag: 'NONE', daysPastGrace: null, memberLoanAccountId: null, message: null };
    }

    const worstLoan = await this.loanModel.findById(worst.account.loanId).exec();
    const cycleDays = worstLoan
      ? (await this.loanProductsService.findByIdOrThrow(worstLoan.productId.toString()))
          .repaymentPeriodDays
      : 7;

    const flag: CustomerRepaymentRiskFlag = worst.daysPastGrace > cycleDays ? 'RED' : 'AMBER';
    const message =
      flag === 'RED'
        ? `Significantly behind on a loan repayment — ${worst.daysPastGrace} day(s) past the grace period (more than one missed repayment cycle).`
        : `Late on a loan repayment — ${worst.daysPastGrace} day(s) past the grace period.`;

    return {
      flag,
      daysPastGrace: worst.daysPastGrace,
      memberLoanAccountId: worst.account._id.toString(),
      message,
    };
  }

  private async totalPenaltiesChargedKobo(memberLoanAccountId: Types.ObjectId): Promise<number> {
    const charges = await this.penaltyChargeModel
      .find({ memberLoanAccountId })
      .select('penaltyAmountKobo')
      .lean()
      .exec();
    return charges.reduce((sum, c) => sum + c.penaltyAmountKobo, 0);
  }

  /**
   * Same FIFO reconciliation as PenaltySweepService.sweepAccountPenalties —
   * see that method's own doc comment. Returns the oldest unpaid overdue
   * installment's days-past-(effective-)grace, or null if the account has
   * none. The FIRST unpaid-and-due installment found in chronological order
   * is always the oldest one, and therefore always has the largest
   * daysLate/daysPastGrace of any unpaid installment on this account
   * (`cumulativeDue` only grows) — so this never needs to keep scanning past
   * its first hit.
   */
  private async worstOverdueForAccount(
    account: MemberLoanAccountDocument,
    referenceDate: Date,
  ): Promise<{ daysPastGrace: number } | null> {
    if (account.schedule.length === 0) {
      return null;
    }

    const loan = await this.loanModel.findById(account.loanId).exec();
    if (!loan) {
      return null; // defensive — should never happen, an account always has a loan
    }
    const product = await this.loanProductsService.findByIdOrThrow(loan.productId.toString());
    const penaltyRule = product.penaltyRule;
    const effectiveGracePeriodDays =
      penaltyRule.gracePeriodDays +
      (account.disbursementChannel === DisbursementChannel.CHEQUE_PICKUP
        ? CHEQUE_PICKUP_PENALTY_GRACE_BUFFER_DAYS
        : 0);

    const totalPenaltiesChargedKobo = await this.totalPenaltiesChargedKobo(account._id);
    const totalOriginalScheduledKobo = account.schedule.reduce((sum, e) => sum + e.totalDue, 0);
    const amountPaidTowardScheduleKobo =
      totalOriginalScheduledKobo + totalPenaltiesChargedKobo - (account.outstandingBalanceKobo ?? 0);

    let cumulativeDue = 0;
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
      const daysPastGrace = daysLate - effectiveGracePeriodDays;
      return daysPastGrace > 0 ? { daysPastGrace } : null;
    }
    return null;
  }
}
