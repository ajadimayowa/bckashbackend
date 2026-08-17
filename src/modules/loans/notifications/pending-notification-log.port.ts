import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { NotificationTrigger } from '../../../common/enums/notification.enums';
import {
  PendingNotificationLog,
  PendingNotificationLogDocument,
} from '../../notifications/schemas/pending-notification-log.schema';
import { NotificationPort } from '../interfaces/notification-port.interface';

/**
 * *** TEMPORARY — SEE PHASE_8_NOTES.md — MUST BE REPLACED IN PHASE 11 ***
 * Per the brief: "NotificationPort's stub should not be a pure no-op — write
 * each call to a PendingNotificationLog collection instead, so nothing is
 * silently lost." Every call below lands as `dispatched: false` — see
 * `PendingNotificationLog`'s own doc comment for what Phase 11 must do with
 * this backlog.
 */
@Injectable()
export class PendingNotificationLogPort implements NotificationPort {
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
