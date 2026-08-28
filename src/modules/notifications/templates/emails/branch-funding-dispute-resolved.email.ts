import { str } from '../format.util';
import { escapeHtml, paragraph, renderEmailLayout } from './email-layout';

/** Sent to whichever manager originally raised the dispute (BranchFundingService.resolveDispute). */
export function branchFundingDisputeResolvedEmail(payload: Record<string, unknown>): string {
  const resolution = str(payload.resolution, 'resolved');
  const resolvedByName = str(payload.resolvedByName, 'head office');
  const note = str(payload.note, '');
  return renderEmailLayout({
    heading: 'Your funding dispute has been resolved',
    bodyHtml: [
      paragraph(
        `${escapeHtml(resolvedByName)} marked your funding dispute as <strong>${escapeHtml(resolution)}</strong>.` +
          (note ? ` ${escapeHtml(note)}` : ''),
      ),
    ].join(''),
  });
}
