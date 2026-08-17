import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';

import { addMonths } from '../../common/date/add-months.util';
import { InterestType } from '../../common/enums/loan-product.enums';
import {
  DisbursementChannel,
  DisbursementVerificationStatus,
  LoanStatus,
  MemberLoanAccountStatus,
} from '../../common/enums/loan.enums';
import { AuditService } from '../../platform/audit/audit.service';
import {
  FACE_COMPARISON_ADAPTER,
  FaceComparisonAdapter,
} from '../../platform/integrations/rekognition/interfaces/face-comparison-adapter.interface';
import { BranchFundBalanceService } from '../branches/branch-fund-balance.service';
import { CustomerService } from '../customers/customer.service';
import { VerificationContext } from '../customers/enums/verification-context.enum';
import {
  calculateFlatInterestSchedule,
  calculateReducingBalanceSchedule,
  FlatScheduleResult,
  ReducingScheduleResult,
} from '../loan-products/calculations';
import { LoanProductsService } from '../loan-products/loan-products.service';
import { BANK_TRANSFER_PORT, BankTransferPort } from './interfaces/bank-transfer-port.interface';
import { LEDGER_POSTING_PORT, LedgerPostingPort } from './interfaces/ledger-posting-port.interface';
import { NOTIFICATION_PORT, NotificationPort } from './interfaces/notification-port.interface';
import { LoansService } from './loans.service';
import {
  BvnRecheckResult,
  DisbursementVerification,
  DisbursementVerificationDocument,
  FacialMatchResult,
} from './schemas/disbursement-verification.schema';
import {
  MemberLoanAccount,
  MemberLoanAccountDocument,
  RepaymentScheduleEntry,
} from './schemas/member-loan-account.schema';
import { Loan, LoanDocument } from './schemas/loan.schema';

export type EscalationResolution = 'OVERRIDE_PASS' | 'REJECT_LOAN';

export interface VerificationOfficeContext {
  officeId?: string;
  officerId?: string;
}

/**
 * *** ASSUMPTION CONFIRMED, SEE PHASE_8_NOTES.md ***
 * All-or-nothing group disbursement: every member's DisbursementVerification
 * must reach PASSED before ANY member's portion disburses, and the branch
 * fund debit happens once for the full `cumulativeAmountKobo`. Built as the
 * default per the brief's own stated preference; the staggered
 * per-member-disbursement alternative was explicitly not built (meaningfully
 * more complex around partial fund-debit/ledger-posting transaction
 * boundaries) — flagged for confirmation before this becomes hard to rework.
 */
@Injectable()
export class LoanVerificationService {
  private readonly logger = new Logger(LoanVerificationService.name);

  constructor(
    @InjectModel(Loan.name) private readonly loanModel: Model<LoanDocument>,
    @InjectModel(MemberLoanAccount.name)
    private readonly memberLoanAccountModel: Model<MemberLoanAccountDocument>,
    @InjectModel(DisbursementVerification.name)
    private readonly disbursementVerificationModel: Model<DisbursementVerificationDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly loanProductsService: LoanProductsService,
    private readonly customerService: CustomerService,
    private readonly branchFundBalanceService: BranchFundBalanceService,
    private readonly loansService: LoansService,
    private readonly auditService: AuditService,
    @Inject(FACE_COMPARISON_ADAPTER) private readonly faceComparisonAdapter: FaceComparisonAdapter,
    @Inject(LEDGER_POSTING_PORT) private readonly ledgerPostingPort: LedgerPostingPort,
    @Inject(NOTIFICATION_PORT) private readonly notificationPort: NotificationPort,
    @Inject(BANK_TRANSFER_PORT) private readonly bankTransferPort: BankTransferPort,
  ) {}

  // ---------------------------------------------------------------------------
  // Per-member verification
  // ---------------------------------------------------------------------------

  /**
   * `channel`/`officeId`/`officerId` are populated identically whether this
   * call originates from a customer's mobile self-service flow (TRANSFER) or
   * an officer's in-person flow (CHEQUE_PICKUP) — confirmed reading: the
   * cheque-pickup officer check IS the pre-disbursement verification for that
   * channel, not a second layer on top of it. `officeContext` is therefore
   * only meaningfully populated for CHEQUE_PICKUP but accepted regardless.
   */
  async initiateMemberVerification(
    loanId: string,
    customerId: string,
    liveImageBuffer: Buffer,
    actorId: string,
    officeContext?: VerificationOfficeContext,
  ): Promise<DisbursementVerificationDocument> {
    const loan = await this.loanModel.findById(loanId).exec();
    if (!loan) {
      throw new NotFoundException(`Loan ${loanId} not found`);
    }
    if (
      loan.status !== LoanStatus.APPROVED &&
      loan.status !== LoanStatus.VERIFICATION_IN_PROGRESS
    ) {
      throw new ConflictException(
        `Loan ${loanId} is not in a state that accepts verification (status: ${loan.status})`,
      );
    }

    const memberAccount = await this.memberLoanAccountModel
      .findOne({ loanId: new Types.ObjectId(loanId), customerId: new Types.ObjectId(customerId) })
      .exec();
    if (!memberAccount) {
      throw new NotFoundException(
        `No MemberLoanAccount for customer ${customerId} on loan ${loanId}`,
      );
    }
    if (memberAccount.status !== MemberLoanAccountStatus.PENDING) {
      throw new ConflictException(
        `MemberLoanAccount for customer ${customerId} is not awaiting disbursement (status: ${memberAccount.status})`,
      );
    }

    if (loan.status === LoanStatus.APPROVED) {
      await this.loanModel
        .updateOne({ _id: loanId }, { $set: { status: LoanStatus.VERIFICATION_IN_PROGRESS } })
        .exec();
    }

    const verificationContext =
      memberAccount.disbursementChannel === DisbursementChannel.CHEQUE_PICKUP
        ? VerificationContext.CHEQUE_PICKUP
        : VerificationContext.PRE_DISBURSEMENT;

    // BVN recheck — always a live call, never consulted against
    // isVerificationFresh's cache, per Phase 5's "never reuse" mode for this
    // call site.
    const bvnRecheck = await this.performBvnRecheck(customerId, verificationContext, actorId);

    const kyc = await this.customerService.getKycRecordOrThrow(customerId);
    if (!kyc.biometricImageKey) {
      throw new BadRequestException(
        `Customer ${customerId} has no biometric image on file — cannot run facial comparison`,
      );
    }

    const comparison = await this.faceComparisonAdapter.compareFaces(
      kyc.biometricImageKey,
      liveImageBuffer,
      {
        calledBy: actorId,
        loanId,
        memberLoanAccountId: memberAccount._id.toString(),
        customerId,
      },
    );
    const facialMatch: FacialMatchResult = {
      status: comparison.isMatch ? 'PASSED' : 'FAILED',
      similarityPercent: comparison.similarityPercent,
      rekognitionRef: randomUUID(),
      verifiedAt: new Date(),
    };

    const overallPassed = bvnRecheck.status === 'PASSED' && facialMatch.status === 'PASSED';
    const status = overallPassed
      ? DisbursementVerificationStatus.PASSED
      : DisbursementVerificationStatus.ESCALATED;

    // Never an automatic dead-end deny — a failing check here could be fraud
    // or just a bad capture, and both need human eyes (resolveEscalation),
    // not an automatic rejection of the whole loan.
    let escalationReason: string | null = null;
    if (!overallPassed) {
      const reasons: string[] = [];
      if (bvnRecheck.status === 'FAILED') {
        reasons.push('BVN recheck failed');
      }
      if (facialMatch.status === 'FAILED') {
        reasons.push(`Facial match below threshold (${facialMatch.similarityPercent}%)`);
      }
      escalationReason = reasons.join('; ');
    }

    const verification = await this.disbursementVerificationModel
      .findOneAndUpdate(
        { loanId: new Types.ObjectId(loanId), memberLoanAccountId: memberAccount._id },
        {
          $set: {
            customerId: new Types.ObjectId(customerId),
            channel: memberAccount.disbursementChannel,
            officeId: officeContext?.officeId ? new Types.ObjectId(officeContext.officeId) : null,
            officerId: officeContext?.officerId
              ? new Types.ObjectId(officeContext.officerId)
              : null,
            bvnRecheck,
            facialMatch,
            status,
            escalationReason,
            resolvedBy: null,
            resolvedAt: null,
            resolutionNote: null,
          },
        },
        { new: true, upsert: true },
      )
      .exec();
    if (!verification) {
      throw new Error(
        `Failed to upsert DisbursementVerification for loan ${loanId}, customer ${customerId}`,
      );
    }

    await this.auditService.record({
      actorId,
      action: 'DISBURSEMENT_VERIFICATION_RECORDED',
      entityType: 'DISBURSEMENT_VERIFICATION',
      entityId: verification._id.toString(),
      after: { status, bvnStatus: bvnRecheck.status, facialStatus: facialMatch.status },
      metadata: { loanId, customerId },
    });

    if (status === DisbursementVerificationStatus.ESCALATED) {
      await this.notificationPort.sendVerificationEscalation(
        loanId,
        customerId,
        escalationReason ?? 'Verification failed',
      );
    } else {
      // Attempt disbursement — a no-op unless every member has now passed.
      // A downstream failure here (e.g. insufficient branch funds) must not
      // make this call appear to fail — the verification itself succeeded.
      await this.tryCheckAndDisburse(loanId, actorId);
    }

    return verification;
  }

  private async performBvnRecheck(
    customerId: string,
    context: VerificationContext,
    actorId: string,
  ): Promise<BvnRecheckResult> {
    try {
      // Reuses CustomerService.recordBvnDirectVerifyForContext, which itself
      // calls BvnVerificationAdapter.directVerify — always live, and records
      // the KYC_DATA_READ audit entry + updates kyc.bvnVerifiedAt.
      await this.customerService.recordBvnDirectVerifyForContext(customerId, context, actorId);
      return { status: 'PASSED', verifiedAt: new Date(), providerRef: randomUUID() };
    } catch {
      // No natural provider transaction reference is exposed by
      // BvnVerificationAdapter's public contract on failure either — see
      // PHASE_8_NOTES.md.
      return { status: 'FAILED', verifiedAt: new Date(), providerRef: randomUUID() };
    }
  }

  // ---------------------------------------------------------------------------
  // Escalation resolution
  // ---------------------------------------------------------------------------

  /**
   * OVERRIDE_PASS is a meaningful compliance exception — logged prominently
   * via a dedicated audit action, with a mandatory `note` explaining why.
   * `verification.status` deliberately stays ESCALATED-then-PASSED (not a new
   * status) — see DisbursementVerification's own doc comment.
   */
  async resolveEscalation(
    verificationId: string,
    actorId: string,
    resolution: EscalationResolution,
    note: string,
  ): Promise<DisbursementVerificationDocument> {
    if (!note || note.trim().length === 0) {
      throw new BadRequestException('A note is required to resolve an escalation');
    }

    const verification = await this.disbursementVerificationModel.findById(verificationId).exec();
    if (!verification) {
      throw new NotFoundException(`DisbursementVerification ${verificationId} not found`);
    }
    if (verification.status !== DisbursementVerificationStatus.ESCALATED) {
      throw new ConflictException(
        `DisbursementVerification ${verificationId} is not ESCALATED (status: ${verification.status})`,
      );
    }

    const loanId = verification.loanId.toString();

    if (resolution === 'REJECT_LOAN') {
      await this.loansService.rejectLoan(loanId, note);

      verification.resolvedBy = new Types.ObjectId(actorId);
      verification.resolvedAt = new Date();
      verification.resolutionNote = note;
      await verification.save();

      await this.auditService.record({
        actorId,
        action: 'DISBURSEMENT_VERIFICATION_REJECT_LOAN',
        entityType: 'DISBURSEMENT_VERIFICATION',
        entityId: verificationId,
        after: { resolution, note },
        metadata: { loanId },
      });
      return verification;
    }

    // OVERRIDE_PASS
    verification.status = DisbursementVerificationStatus.PASSED;
    verification.resolvedBy = new Types.ObjectId(actorId);
    verification.resolvedAt = new Date();
    verification.resolutionNote = note;
    await verification.save();

    await this.auditService.record({
      actorId,
      action: 'DISBURSEMENT_VERIFICATION_OVERRIDE_PASS',
      entityType: 'DISBURSEMENT_VERIFICATION',
      entityId: verificationId,
      before: { status: DisbursementVerificationStatus.ESCALATED },
      after: { status: DisbursementVerificationStatus.PASSED, note },
      metadata: { loanId, compliance: true },
    });

    await this.tryCheckAndDisburse(loanId, actorId);
    return verification;
  }

  private async tryCheckAndDisburse(loanId: string, actorId: string | null): Promise<void> {
    try {
      await this.checkAndDisburse(loanId, actorId);
    } catch (error) {
      this.logger.warn(
        `checkAndDisburse did not complete for loan ${loanId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Disbursement
  // ---------------------------------------------------------------------------

  /**
   * Public and idempotent — safe to call repeatedly (e.g. to retry after an
   * `InsufficientBranchFundsException` is resolved by additional branch
   * funding). No-ops (returns the loan unchanged) unless the loan is
   * VERIFICATION_IN_PROGRESS and every one of its MemberLoanAccounts has a
   * DisbursementVerification at PASSED.
   */
  async checkAndDisburse(loanId: string, actorId: string | null = null): Promise<LoanDocument> {
    const loan = await this.loanModel.findById(loanId).exec();
    if (!loan) {
      throw new NotFoundException(`Loan ${loanId} not found`);
    }
    if (loan.status !== LoanStatus.VERIFICATION_IN_PROGRESS) {
      return loan;
    }

    const accounts = await this.memberLoanAccountModel
      .find({ loanId: new Types.ObjectId(loanId) })
      .exec();
    const verifications = await this.disbursementVerificationModel
      .find({ loanId: new Types.ObjectId(loanId) })
      .exec();
    const passedAccountIds = new Set(
      verifications
        .filter((v) => v.status === DisbursementVerificationStatus.PASSED)
        .map((v) => v.memberLoanAccountId.toString()),
    );

    const allPassed =
      accounts.length > 0 && accounts.every((a) => passedAccountIds.has(a._id.toString()));
    if (!allPassed) {
      return loan;
    }

    return this.disburse(loan, accounts, actorId);
  }

  private async disburse(
    loan: LoanDocument,
    accounts: MemberLoanAccountDocument[],
    actorId: string | null,
  ): Promise<LoanDocument> {
    const product = await this.loanProductsService.findByIdOrThrow(loan.productId.toString());
    // Captured once, outside the transaction retry loop, and reused for both
    // Loan.disbursedAt and every schedule entry's dueDate — so a schedule's
    // due dates are always anchored to the exact instant disbursement
    // actually happened, not a slightly-later re-read.
    const disbursementDate = new Date();

    const session = await this.connection.startSession();
    let disbursedLoan: LoanDocument | null = null;

    try {
      await session.withTransaction(async () => {
        // The atomic, race-safe guarded decrement from Phase 4 — throws
        // InsufficientBranchFundsException (aborting this transaction, so
        // nothing below applies) rather than being reimplemented here.
        await this.branchFundBalanceService.debit(
          loan.branchId.toString(),
          loan.cumulativeAmountKobo,
          session,
        );

        for (const account of accounts) {
          const scheduleResult =
            product.interestType === InterestType.FLAT
              ? calculateFlatInterestSchedule(
                  account.principalAmountKobo,
                  product.interestRate,
                  loan.tenureMonths,
                )
              : calculateReducingBalanceSchedule(
                  account.principalAmountKobo,
                  product.interestRate,
                  loan.tenureMonths,
                );
          const schedule = this.normalizeSchedule(
            scheduleResult,
            account.principalAmountKobo,
            disbursementDate,
          );
          const totalInterestKobo = schedule.reduce((sum, entry) => sum + entry.interestPortion, 0);

          await this.memberLoanAccountModel
            .updateOne(
              { _id: account._id },
              {
                $set: {
                  schedule,
                  outstandingBalanceKobo: account.principalAmountKobo + totalInterestKobo,
                  status: MemberLoanAccountStatus.ACTIVE,
                },
              },
              { session },
            )
            .exec();
        }

        const updated = await this.loanModel
          .findOneAndUpdate(
            { _id: loan._id },
            { $set: { status: LoanStatus.DISBURSED, disbursedAt: disbursementDate } },
            { new: true, session },
          )
          .exec();
        disbursedLoan = updated;
      });
    } finally {
      await session.endSession();
    }

    if (!disbursedLoan) {
      throw new Error(
        `Disbursement transaction for loan ${loan._id.toString()} completed without a result`,
      );
    }
    const finalLoan = disbursedLoan as LoanDocument;

    await this.auditService.record({
      actorId,
      action: 'LOAN_DISBURSED',
      entityType: 'LOAN',
      entityId: finalLoan._id.toString(),
      after: { status: LoanStatus.DISBURSED, cumulativeAmountKobo: loan.cumulativeAmountKobo },
    });

    // Ledger posting — moved here (Phase 10) from inside the transaction
    // above. LedgerPostingService manages its own independent session per
    // posting (see LedgerPostingPort's doc comment), so nesting its call
    // inside this method's own still-open `session.withTransaction(...)` was
    // never actually atomic with the domain write — it only risked a real
    // deadlock (two open transactions on the same connection, one awaiting
    // the other), which is exactly what surfaced as a hung test suite. Moving
    // the call to after commit removes the deadlock without giving up
    // anything that was ever really guaranteed. A ledger-posting failure here
    // does NOT roll back the (already-committed) disbursement — it's caught,
    // logged, and recorded as its own audit entry so a missing journal entry
    // is a visible, reconcilable ops event rather than a silently swallowed
    // one (elevated above the plain warn-log used for notification/transfer
    // failures below, given the financial-integrity stakes). See
    // PHASE_10_NOTES.md.
    for (const account of accounts) {
      try {
        await this.ledgerPostingPort.postDisbursement({
          loanId: loan._id.toString(),
          memberLoanAccountId: account._id.toString(),
          amountKobo: account.principalAmountKobo,
          branchId: loan.branchId.toString(),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Ledger posting failed for disbursement of memberLoanAccount ${account._id.toString()}: ${message}`,
        );
        await this.auditService.record({
          actorId,
          action: 'LEDGER_POST_DISBURSEMENT_FAILED',
          entityType: 'MEMBER_LOAN_ACCOUNT',
          entityId: account._id.toString(),
          after: { amountKobo: account.principalAmountKobo, error: message },
        });
      }
    }

    // Outside the transaction, after commit — never let a post-disbursement
    // step's failure roll back a successful disbursement. Each member is
    // handled independently so one failure doesn't block another's
    // notification/transfer.
    for (const account of accounts) {
      try {
        if (account.disbursementChannel === DisbursementChannel.TRANSFER) {
          await this.bankTransferPort.initiateTransfer(
            account._id.toString(),
            account.customerId.toString(),
            account.principalAmountKobo,
          );
        }
        // CHEQUE_PICKUP: nothing further here — the account being ACTIVE with
        // chequeHandedOverAt still null already represents "ready for
        // handover"; see confirmChequeHandover for the separate, later
        // physical-handover confirmation.
        await this.notificationPort.sendDisbursementCompleted(
          account.customerId.toString(),
          account.principalAmountKobo,
          account.disbursementChannel,
        );
      } catch (error) {
        this.logger.warn(
          `Post-disbursement step failed for memberLoanAccount ${account._id.toString()}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return finalLoan;
  }

  /**
   * Unifies Phase 7's two calculation functions' slightly different return
   * shapes into one persisted `RepaymentScheduleEntry[]` — see that class's
   * own doc comment. FLAT schedules don't natively carry opening/closing
   * balance, so they're derived here by tracking cumulative principal paid
   * down; this never re-derives principal/interest amounts themselves, only
   * adds the balance bookkeeping around Phase 7's already-correct numbers.
   */
  private normalizeSchedule(
    result: FlatScheduleResult | ReducingScheduleResult,
    principalKobo: number,
    disbursementDate: Date,
  ): RepaymentScheduleEntry[] {
    if ('installmentAmountKobo' in result) {
      let outstanding = principalKobo;
      return result.schedule.map((entry) => {
        const openingBalance = outstanding;
        outstanding -= entry.principalPortion;
        return {
          installmentNumber: entry.installmentNumber,
          dueDate: addMonths(disbursementDate, entry.installmentNumber),
          openingBalance,
          principalPortion: entry.principalPortion,
          interestPortion: entry.interestPortion,
          totalDue: entry.totalDue,
          closingBalance: outstanding,
        };
      });
    }

    return result.schedule.map((entry) => ({
      installmentNumber: entry.installmentNumber,
      dueDate: addMonths(disbursementDate, entry.installmentNumber),
      openingBalance: entry.openingBalance,
      principalPortion: entry.principalPortion,
      interestPortion: entry.interestPortion,
      totalDue: entry.totalDue,
      closingBalance: entry.closingBalance,
    }));
  }

  // ---------------------------------------------------------------------------
  // Cheque handover — a separate, simple confirmation step, deliberately NOT
  // inside the disbursement transaction (the physical handover timing doesn't
  // affect the money-movement/fund-debit correctness).
  // ---------------------------------------------------------------------------

  async confirmChequeHandover(
    memberLoanAccountId: string,
    officerId: string,
  ): Promise<MemberLoanAccountDocument> {
    const account = await this.memberLoanAccountModel.findById(memberLoanAccountId).exec();
    if (!account) {
      throw new NotFoundException(`MemberLoanAccount ${memberLoanAccountId} not found`);
    }
    if (account.disbursementChannel !== DisbursementChannel.CHEQUE_PICKUP) {
      throw new BadRequestException(
        `MemberLoanAccount ${memberLoanAccountId} is not a CHEQUE_PICKUP disbursement`,
      );
    }
    if (account.status !== MemberLoanAccountStatus.ACTIVE) {
      throw new ConflictException(
        `MemberLoanAccount ${memberLoanAccountId} has not been disbursed yet`,
      );
    }
    if (account.chequeHandedOverAt) {
      throw new ConflictException(
        `MemberLoanAccount ${memberLoanAccountId}'s cheque was already handed over`,
      );
    }

    account.chequeHandedOverAt = new Date();
    await account.save();

    await this.auditService.record({
      actorId: officerId,
      action: 'CHEQUE_HANDED_OVER',
      entityType: 'MEMBER_LOAN_ACCOUNT',
      entityId: memberLoanAccountId,
      after: { chequeHandedOverAt: account.chequeHandedOverAt },
    });

    return account;
  }
}
