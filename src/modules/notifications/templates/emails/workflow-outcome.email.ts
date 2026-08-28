import { str } from '../format.util';
import { escapeHtml, paragraph, renderEmailLayout } from './email-layout';

export function workflowOutcomeEmail(payload: Record<string, unknown>): string {
  const entityType = str(payload.entityType, 'request');
  const outcome = str(payload.outcome, 'decided');
  const comment = payload.comment ? str(payload.comment, '') : null;
  return renderEmailLayout({
    heading: `Your ${entityType} request has been ${outcome}`,
    bodyHtml: [
      paragraph(
        `Your ${escapeHtml(entityType)} request has been <strong>${escapeHtml(outcome)}</strong>.`,
      ),
      comment ? paragraph(`Comment: ${escapeHtml(comment)}`) : '',
    ].join(''),
  });
}
