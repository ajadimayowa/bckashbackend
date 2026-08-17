import { NotificationRecipient } from './interfaces/notification-recipient.interface';

/** Named exactly as anticipated in app.module.ts's Phase 1/2 BullMQ comment. */
export const NOTIFICATION_DISPATCH_QUEUE = 'notification-dispatch';

export interface NotificationDispatchJobData {
  type: string;
  recipient: NotificationRecipient;
  payload: Record<string, unknown>;
}
