import { NotificationCategory } from '../../common/enums/notification.enums';
import { NotificationRecipient } from './interfaces/notification-recipient.interface';

/** Named exactly as anticipated in app.module.ts's Phase 1/2 BullMQ comment. */
export const NOTIFICATION_DISPATCH_QUEUE = 'notification-dispatch';

export interface NotificationDispatchJobData {
  type: string;
  recipient: NotificationRecipient;
  payload: Record<string, unknown>;
  /** Whatever the notification is *about* — reused as the in-app Notification row's own dedupe/idempotency key (see NotificationInboxService.persistCopies). Same value NotificationService.dispatch already folds into the BullMQ job id. */
  sourceEntityId: string;
  /** In-app routing/display metadata — see NotificationService.dispatch's own doc comment on why this stays optional at every existing call site. */
  category: NotificationCategory;
  branchId: string | null;
}
