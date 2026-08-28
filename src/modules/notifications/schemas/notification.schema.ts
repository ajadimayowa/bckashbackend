import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';

import { NotificationCategory, NotificationTrigger } from '../../../common/enums/notification.enums';

export type NotificationDocument = HydratedDocument<Notification>;

/**
 * A persisted, in-app copy of a notification — layered on top of (not a
 * replacement for) the existing EMAIL/SMS dispatch pipeline (see
 * NotificationService.dispatch, NotificationDispatchProcessor). Written by
 * `NotificationDispatchProcessor` alongside its existing email/SMS send, so
 * it inherits that pipeline's per-recipient job shape — including its
 * dedupe key, reused below as this schema's own unique index. Every
 * SuperAdmin additionally gets their own mirror row for every staff-facing
 * notification (see NotificationInboxService.persistCopies), stamped
 * `NotificationCategory.SUPERADMIN_MIRROR` when they aren't the primary
 * recipient — this is a real, independent row (not a shared `readBy[]`
 * flag), so each SuperAdmin reads at their own pace.
 */
@Schema({ timestamps: true, collection: 'notifications' })
export class Notification {
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Staff', required: true })
  recipientStaffId!: Types.ObjectId;

  @Prop({ type: String, enum: NotificationTrigger, required: true })
  type!: NotificationTrigger;

  @Prop({ type: String, enum: NotificationCategory, required: true })
  category!: NotificationCategory;

  /** Whatever the notification is *about* — a fundingId, a BranchRequest id, ... — same value used to build the BullMQ job's dedupe key. */
  @Prop({ type: String, required: true })
  sourceEntityId!: string;

  /** null for a notification with no single branch (e.g. a SuperAdmin org-wide item that isn't branch-scoped). */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Branch', default: null })
  branchId!: Types.ObjectId | null;

  @Prop({ type: String, required: true })
  title!: string;

  @Prop({ type: String, required: true })
  body!: string;

  @Prop({ type: Boolean, required: true, default: false })
  isRead!: boolean;

  @Prop({ type: Date, default: null })
  readAt!: Date | null;
}

export const NotificationSchema = SchemaFactory.createForClass(Notification);

// Idempotency — the same (type, sourceEntityId, recipient) key
// NotificationService.dispatch already uses for its BullMQ job id, so a
// retried job never duplicates a row (see NotificationInboxService.persistCopies's upsert).
NotificationSchema.index({ type: 1, sourceEntityId: 1, recipientStaffId: 1 }, { unique: true });
// Paginated inbox, newest first.
NotificationSchema.index({ recipientStaffId: 1, createdAt: -1 });
// Mark-all-read / unread count.
NotificationSchema.index({ recipientStaffId: 1, isRead: 1 });
