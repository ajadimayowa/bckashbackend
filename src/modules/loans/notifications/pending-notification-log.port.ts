import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { NotificationTrigger } from '../../../common/enums/notification.enums';
import {
  PendingNotificationLog,
  PendingNotificationLogDocument,
} from '../../notifications/schemas/pending-notification-log.schema';
import { NotificationPort } from '../interfaces/notification-port.interface';

/**
 * *** RETAINED FOR TESTS ONLY AS OF PHASE 11 — SEE PHASE_11_NOTES.md ***
 * `RealNotificationPort` (`modules/notifications`) is bound in production;
 * this stub still backs the loans/repayments test fixtures that don't need
 * real dispatch. Per the original Phase 8 brief: "should not be a pure
 * no-op — write each call to a PendingNotificationLog collection instead."
 * Every customer-facing call below still lands as `dispatched: false` — see
 * `PendingNotificationLog`'s own doc comment.
 */
@Injectable()
export class PendingNotificationLogPort implements NotificationPort {
  private readonly logger = new Logger(PendingNotificationLogPort.name);

  constructor(
    @InjectModel(PendingNotificationLog.name)
    private readonly pendingNotificationLogModel: Model<PendingNotificationLogDocument>,
  ) {}

  async sendLoanRaisedNotification(
    customerId: string,
    memberAmountKobo: number,
    groupCumulativeAmountKobo: number,
    raisedAt: Date,
  ): Promise<void> {
    await this.enqueue(NotificationTrigger.LOAN_RAISED, customerId, {
      memberAmountKobo,
      groupCumulativeAmountKobo,
      raisedAt,
    });
  }

  async sendVerificationEscalation(
    loanId: string,
    customerId: string,
    reason: string,
  ): Promise<void> {
    await this.enqueue(NotificationTrigger.VERIFICATION_ESCALATED, customerId, {
      loanId,
      reason,
    });
  }

  async sendDisbursementCompleted(
    customerId: string,
    amountKobo: number,
    channel: string,
  ): Promise<void> {
    await this.enqueue(NotificationTrigger.DISBURSEMENT_COMPLETED, customerId, {
      amountKobo,
      channel,
    });
  }

  async sendPenaltyCharged(customerId: string, amountKobo: number, context: string): Promise<void> {
    await this.enqueue(NotificationTrigger.PENALTY_CHARGED, customerId, { amountKobo, context });
  }

  /**
   * Staff-facing (see NotificationPort's own doc comment) — doesn't fit
   * PendingNotificationLog's customer-shaped schema (`recipientCustomerId`
   * is a Customer ref, and there's no single customer recipient here), so
   * this deliberately doesn't write to that collection. A logged no-op is
   * sufficient for a test-only stub — tests assert on this method being
   * called (spy), not on any persisted side effect.
   */
  sendRepaymentDisputeRaised(params: {
    repaymentRecordId: string;
    branchId: string;
    recordedBy: string;
    raisedBy: string;
    reason: string;
    relatedWorkflowRequestId: string;
  }): Promise<void> {
    this.logger.log(`[STUB] Repayment dispute raised: ${JSON.stringify(params)}`);
    return Promise.resolve();
  }

  private async enqueue(
    type: NotificationTrigger,
    recipientCustomerId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.pendingNotificationLogModel.create({
      type,
      recipientCustomerId: new Types.ObjectId(recipientCustomerId),
      payload,
      createdAt: new Date(),
      dispatched: false,
    });
  }
}
