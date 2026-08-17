import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Job } from 'bullmq';
import { Model } from 'mongoose';

import { NotificationChannel, NotificationTrigger } from '../../common/enums/notification.enums';
import {
  EMAIL_ADAPTER,
  EmailAdapter,
} from '../../platform/integrations/brevo/interfaces/email-adapter.interface';
import {
  SMS_ADAPTER,
  SmsAdapter,
} from '../../platform/integrations/termii/interfaces/sms-adapter.interface';
import {
  NOTIFICATION_DISPATCH_QUEUE,
  NotificationDispatchJobData,
} from './notification-dispatch.queue';
import {
  NotificationDeadLetterLog,
  NotificationDeadLetterLogDocument,
} from './schemas/notification-dead-letter-log.schema';
import { NotificationTemplateRegistry } from './templates/notification-template-registry.service';

/**
 * One job = one notification to one recipient. Renders the registered
 * template for `job.data.type`, attempts the email leg if `recipient.email`
 * is present and the SMS leg if `recipient.phone` is present, and throws
 * (triggering BullMQ's retry/backoff) if any *attempted* channel failed —
 * a channel that was never attempted (no email on file) never counts
 * against success. If *neither* channel is available at all, that's a
 * dead-end no amount of retrying fixes — logged as a warning (never a
 * silent drop) and resolved without throwing. See PHASE_11_NOTES.md.
 */
@Processor(NOTIFICATION_DISPATCH_QUEUE)
export class NotificationDispatchProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationDispatchProcessor.name);

  constructor(
    @Inject(EMAIL_ADAPTER) private readonly emailAdapter: EmailAdapter,
    @Inject(SMS_ADAPTER) private readonly smsAdapter: SmsAdapter,
    private readonly templateRegistry: NotificationTemplateRegistry,
    @InjectModel(NotificationDeadLetterLog.name)
    private readonly deadLetterModel: Model<NotificationDeadLetterLogDocument>,
  ) {
    super();
  }

  async process(job: Job<NotificationDispatchJobData>): Promise<void> {
    const { type, recipient, payload } = job.data;
    const template = this.templateRegistry.getTemplate(type as NotificationTrigger);

    if (!recipient.email && !recipient.phone) {
      this.logger.warn(
        `Notification ${type} for recipient ${recipient.id}: no email or phone available — nothing to send.`,
      );
      return;
    }

    const failures: string[] = [];

    if (recipient.email) {
      const subject = template.emailSubject?.(payload) ?? type;
      const body = template.emailBody?.(payload) ?? '';
      const result = await this.emailAdapter.send(recipient.email, subject, body);
      if (!result.success) {
        failures.push(`email: ${result.error ?? 'unknown error'}`);
      }
    }

    if (recipient.phone) {
      const smsBody = template.smsBody?.(payload) ?? template.emailSubject?.(payload) ?? type;
      const result = await this.smsAdapter.send(recipient.phone, smsBody);
      if (!result.success) {
        failures.push(`sms: ${result.error ?? 'unknown error'}`);
      }
    }

    if (failures.length > 0) {
      throw new Error(failures.join('; '));
    }
  }

  /**
   * Fires on every processor throw, intermediate retries included — only
   * dead-letter once BullMQ has actually exhausted every configured attempt
   * (`attemptsMade >= opts.attempts`), never on an intermediate retry.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<NotificationDispatchJobData> | undefined, error: Error): Promise<void> {
    if (!job) {
      return;
    }
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) {
      return; // a retry is still scheduled — not the final failure.
    }

    const { type, recipient, payload } = job.data;
    // The schema's `channel` field is singular; when both legs were
    // attempted and both failed, `lastError` retains the full detail (both
    // "email: ..." and "sms: ..." segments) but `channel` biases toward
    // EMAIL as the primary channel — a flagged simplification, see
    // PHASE_11_NOTES.md.
    const channel = error.message.includes('email:')
      ? NotificationChannel.EMAIL
      : NotificationChannel.SMS;
    this.logger.error(
      `Notification ${type} for recipient ${recipient.id} dead-lettered after ${job.attemptsMade} attempt(s): ${error.message}`,
    );
    await this.deadLetterModel.create({
      type,
      recipientId: recipient.id,
      channel,
      payload,
      lastError: error.message,
      failedAt: new Date(),
      attemptCount: job.attemptsMade,
    });
  }
}
