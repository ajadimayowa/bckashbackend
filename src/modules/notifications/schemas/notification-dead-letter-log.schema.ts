import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import { NotificationChannel, NotificationTrigger } from '../../../common/enums/notification.enums';

export type NotificationDeadLetterLogDocument = HydratedDocument<NotificationDeadLetterLog>;

/**
 * Written when a notification job exhausts every retry attempt (see
 * `NotificationDispatchProcessor`'s `@OnWorkerEvent('failed')` handler) —
 * a failed notification must never silently vanish. `GET
 * /notifications/dead-letters` (Admin-only) surfaces this collection.
 */
@Schema({ timestamps: false, collection: 'notification_dead_letter_logs' })
export class NotificationDeadLetterLog {
  @Prop({ type: String, enum: NotificationTrigger, required: true })
  type!: NotificationTrigger;

  @Prop({ type: String, required: true })
  recipientId!: string;

  @Prop({ type: String, enum: NotificationChannel, required: true })
  channel!: NotificationChannel;

  @Prop({ type: Object, required: true })
  payload!: Record<string, unknown>;

  @Prop({ type: String, required: true })
  lastError!: string;

  @Prop({ type: Date, required: true, default: () => new Date() })
  failedAt!: Date;

  @Prop({ type: Number, required: true })
  attemptCount!: number;
}

export const NotificationDeadLetterLogSchema =
  SchemaFactory.createForClass(NotificationDeadLetterLog);

NotificationDeadLetterLogSchema.index({ failedAt: -1 });
NotificationDeadLetterLogSchema.index({ type: 1, recipientId: 1 });
