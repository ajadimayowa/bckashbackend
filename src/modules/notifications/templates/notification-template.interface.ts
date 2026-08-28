import { NotificationTrigger } from '../../../common/enums/notification.enums';

/**
 * Deliberately simple — a typed map from trigger to subject/body builders,
 * not a templating engine. `payload` is untyped `Record<string, unknown>`
 * here (the registry is generic over every trigger); each template function
 * narrows/casts internally — see notification-templates.ts.
 */
export interface NotificationTemplate {
  type: NotificationTrigger;
  emailSubject?: (payload: Record<string, unknown>) => string;
  emailBody?: (payload: Record<string, unknown>) => string;
  smsBody?: (payload: Record<string, unknown>) => string;
  /**
   * In-app bell copy (see NotificationInboxService.persistCopies) — both
   * optional, defaulting to `emailSubject`/`smsBody` respectively when a
   * trigger doesn't define its own (see NotificationDispatchProcessor's own
   * comment on why the fallback is `smsBody`, never `emailBody` — that one
   * renders full branded HTML, unsuitable for a plain-text in-app card).
   */
  inAppTitle?: (payload: Record<string, unknown>) => string;
  inAppBody?: (payload: Record<string, unknown>) => string;
}
