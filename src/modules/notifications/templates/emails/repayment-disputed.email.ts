import { str } from '../format.util';
import { escapeHtml, paragraph, renderEmailLayout } from './email-layout';

/** Staff-facing (see NotificationPort's own doc comment) — sent to the involved parties, not the customer. */
export function repaymentDisputedEmail(payload: Record<string, unknown>): string {
  const repaymentRecordId = str(payload.repaymentRecordId, '');
  const reason = str(payload.reason, 'unspecified');
  return renderEmailLayout({
    heading: 'A repayment dispute has been raised',
    bodyHtml: [
      paragraph(
        `A dispute has been raised on repayment record <strong>${escapeHtml(repaymentRecordId)}</strong>.`,
      ),
      paragraph(`Reason: ${escapeHtml(reason)}`),
      paragraph('Please review this case.'),
    ].join(''),
  });
}
