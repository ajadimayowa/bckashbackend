import { str } from '../format.util';
import { escapeHtml, paragraph, renderEmailLayout } from './email-layout';

export function fundingReminderEmail(payload: Record<string, unknown>): string {
  const details = str(payload.details, '');
  return renderEmailLayout({
    heading: 'Branch funding reminder',
    bodyHtml: [
      paragraph('This is a reminder that branch funding is due.'),
      details ? paragraph(escapeHtml(details)) : '',
    ].join(''),
  });
}
