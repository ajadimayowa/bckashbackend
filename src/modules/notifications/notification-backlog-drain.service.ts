import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { CustomerRecipientResolver } from './recipient-resolution/customer-recipient.resolver';
import { NotificationService } from './notification.service';
import {
  PendingNotificationLog,
  PendingNotificationLogDocument,
} from './schemas/pending-notification-log.schema';

export interface BacklogDrainResult {
  found: number;
  drained: number;
  skipped: number;
}

/**
 * One-time backlog drain for everything Phase 8/9's `PendingNotificationLogPort`
 * stub wrote before this phase's real `NotificationPort` existed — see that
 * schema's own doc comment. Explicit Admin-triggered endpoint
 * (`POST /notifications/backlog/drain`), not run automatically on module
 * init/every deploy — see PHASE_11_NOTES.md for why.
 *
 * Idempotent and safe to re-run (including a restart mid-drain):
 *   1. Enqueue first, using the log entry's own `_id` as the dispatch job's
 *      `sourceEntityId` — BullMQ's own job-id dedupe (see
 *      `NotificationService.dispatch`) means re-enqueuing the same entry
 *      twice (two concurrent drain runs racing the same row before either
 *      marks it) is already a safe no-op.
 *   2. THEN atomically mark `dispatched: true` via the same "conditional
 *      update on the flag itself" pattern used elsewhere in this system for
 *      exactly-once semantics (e.g. `RepaymentsService.applyToBalance`'s
 *      `appliedToBalance` guard) — only entries still `dispatched: false`
 *      get flipped, so a second drain run's conditional update on an
 *      already-flipped row is a harmless no-op match-zero.
 *   3. If step 1 throws (e.g. mid-drain crash), the entry is left
 *      `dispatched: false` and picked up again by the next drain run —
 *      "mark dispatched only after successful enqueue," per the brief.
 */
@Injectable()
export class NotificationBacklogDrainService {
  private readonly logger = new Logger(NotificationBacklogDrainService.name);

  constructor(
    @InjectModel(PendingNotificationLog.name)
    private readonly pendingNotificationLogModel: Model<PendingNotificationLogDocument>,
    private readonly customerRecipientResolver: CustomerRecipientResolver,
    private readonly notificationService: NotificationService,
  ) {}

  async drain(): Promise<BacklogDrainResult> {
    const pending = await this.pendingNotificationLogModel.find({ dispatched: false }).exec();
    let drained = 0;
    let skipped = 0;

    for (const entry of pending) {
      try {
        const recipient = await this.customerRecipientResolver.resolve(
          entry.recipientCustomerId.toString(),
        );
        await this.notificationService.dispatch(
          entry.type,
          entry._id.toString(),
          recipient,
          entry.payload,
        );

        await this.pendingNotificationLogModel
          .findOneAndUpdate({ _id: entry._id, dispatched: false }, { $set: { dispatched: true } })
          .exec();
        drained += 1;
      } catch (error) {
        // Left as dispatched:false — picked up again by the next drain run.
        skipped += 1;
        this.logger.warn(
          `Backlog drain: could not enqueue PendingNotificationLog ${entry._id.toString()}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    this.logger.log(
      `Backlog drain complete: ${pending.length} found, ${drained} enqueued, ${skipped} skipped.`,
    );
    return { found: pending.length, drained, skipped };
  }
}
