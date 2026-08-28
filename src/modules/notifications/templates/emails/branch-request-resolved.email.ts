import { str } from '../format.util';
import { escapeHtml, paragraph, renderEmailLayout } from './email-layout';

/** Sent to the specific manager who raised the request, once it's resolved (BranchRequestsService.resolve) — this leg previously sent no notification at all. */
export function branchRequestResolvedEmail(payload: Record<string, unknown>): string {
  const subject = str(payload.subject, 'your request');
  const resolvedByName = str(payload.resolvedByName, 'head office');
  const note = str(payload.note, '');
  return renderEmailLayout({
    heading: 'Your request has been resolved',
    bodyHtml: [
      paragraph(
        `${escapeHtml(resolvedByName)} resolved your request "<strong>${escapeHtml(subject)}</strong>".` +
          (note ? ` ${escapeHtml(note)}` : ''),
      ),
    ].join(''),
  });
}
