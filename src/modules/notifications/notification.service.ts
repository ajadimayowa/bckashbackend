import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';

import type { NotificationConfig } from '../../common/config/configuration';
import { NotificationCategory, NotificationTrigger } from '../../common/enums/notification.enums';
import { NotificationRecipient } from './interfaces/notification-recipient.interface';
import {
  NOTIFICATION_DISPATCH_QUEUE,
  NotificationDispatchJobData,
} from './notification-dispatch.queue';

/**
 * The single entry point every trigger calls — no individual module ever
 * constructs a BullMQ job directly (see `RealNotificationPort`, the only
 * consumer). For multi-recipient cases (escalations/disputes), the caller
 * calls `dispatch` once per resolved recipient rather than this service
 * building special multi-recipient logic — the queue's unit of work stays
 * "one notification to one recipient."
 */
@Injectable()
export class NotificationService {
  constructor(
    @InjectQueue(NOTIFICATION_DISPATCH_QUEUE) private readonly queue: Queue,
    private readonly configService: ConfigService,
  ) {}

  /**
   * `sourceEntityId` is whatever the notification is *about* (a loanId, a
   * repaymentRecordId, a PendingNotificationLog._id when draining the
   * backlog, ...) — combined with `type` and the recipient's id into a
   * stable BullMQ job id (`${type}:${sourceEntityId}:${recipient.id}`), so a
   * notification trigger firing twice upstream (or two concurrent backlog
   * drain passes racing the same row) enqueues at most one actual job —
   * BullMQ treats a duplicate job id as a no-op, no custom dedupe needed.
   */
  async dispatch(
    type: NotificationTrigger,
    sourceEntityId: string,
    recipient: NotificationRecipient,
    payload: Record<string, unknown>,
    /**
     * In-app routing/display metadata — optional and additive, so every
     * pre-existing call site (~20 of them, some on hot paths like login OTP)
     * is unaffected. Omit entirely for a trigger that shouldn't route
     * in-app-specific category/branch context (the in-app copy still gets
     * written — see NotificationDispatchProcessor — just under
     * `NotificationCategory.GENERAL`, `branchId: null`).
     */
    inAppMeta?: { category?: NotificationCategory; branchId?: string | null },
  ): Promise<void> {
    const notificationConfig = this.configService.get<NotificationConfig>('notification');
    const jobId = `${type}:${sourceEntityId}:${recipient.id}`;

    const jobData: NotificationDispatchJobData = {
      type,
      recipient,
      payload,
      sourceEntityId,
      category: inAppMeta?.category ?? NotificationCategory.GENERAL,
      branchId: inAppMeta?.branchId ?? null,
    };

    await this.queue.add(type, jobData, {
      jobId,
      attempts: notificationConfig?.maxAttempts,
      backoff: {
        type: 'exponential',
        delay: notificationConfig?.backoffBaseDelayMs,
      },
      removeOnComplete: true,
      // Kept off Redis's own retained-job list once dead-lettered — our
      // own NotificationDeadLetterLog is the durable failure record, see
      // NotificationDispatchProcessor.
      removeOnFail: true,
    });
  }
}
