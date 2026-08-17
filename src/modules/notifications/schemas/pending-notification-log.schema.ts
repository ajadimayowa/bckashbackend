import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

import { NotificationTrigger } from '../../../common/enums/notification.enums';

export type PendingNotificationLogDocument = HydratedDocument<PendingNotificationLog>;

/**
 * *** BACKLOG TABLE FOR PHASE 11 (NOTIFICATIONS) — SEE PHASE_8_NOTES.md ***
 *
 * Written by Phase 8's `NotificationPort` stub implementation
 * (modules/loans/notifications/pending-notification-log.port.ts) instead of
 * ever actually sending an email/SMS — the brief is explicit that this stub
 * must not be a silent no-op like `StubLedgerPostingPort`. Every notification
 * this phase would have sent (loan raised, verification escalated,
 * disbursement completed) lands here as `dispatched: false` instead.
 *
 * Phase 11 MUST drain this backlog when it wires up the real Brevo/Termii
 * queue — i.e. it should not assume a clean slate; query
 * `{ dispatched: false }` on boot (or via a startup job) and process every
 * row already sitting here from Phase 8 (and any other phase's stub usage)
 * before/alongside handling newly-queued notifications.
 *
 * Defined here (in the notifications module, which Phase 11 owns) rather than
 * inside the loans module, even though only Phase 8 writes to it today — same
 * "the schema lives with the domain it belongs to, not the domain that
 * happens to be its first writer" reasoning used for cross-module schema
 * registration elsewhere (see PHASE_3_NOTES.md). No NotificationsModule
 * exists yet (Phase 11's job) — modules/loans/loans.module.ts registers this
 * schema directly via MongooseModule.forFeature, same raw-schema-import
 * pattern GroupsModule uses for Branch/Customer.
 */
@Schema({ timestamps: false, collection: 'pending_notification_logs' })
export class PendingNotificationLog {
  @Prop({ type: String, enum: NotificationTrigger, required: true })
  type!: NotificationTrigger;

  @Prop({ type: Types.ObjectId, ref: 'Customer', required: true })
  recipientCustomerId!: Types.ObjectId;

  @Prop({ type: Object, required: true })
  payload!: Record<string, unknown>;

  @Prop({ type: Date, required: true, default: () => new Date() })
  createdAt!: Date;

  @Prop({ type: Boolean, required: true, default: false })
  dispatched!: boolean;
}

export const PendingNotificationLogSchema = SchemaFactory.createForClass(PendingNotificationLog);

PendingNotificationLogSchema.index({ dispatched: 1, createdAt: 1 });
PendingNotificationLogSchema.index({ recipientCustomerId: 1, createdAt: -1 });
