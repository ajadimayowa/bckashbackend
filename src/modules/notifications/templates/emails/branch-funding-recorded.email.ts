import { naira, str } from '../format.util';
import { escapeHtml, paragraph, renderEmailLayout } from './email-layout';

/** Sent to a branch's current manager right after head office records a new funding record for it (BranchFundingService.recordFunding). */
export function branchFundingRecordedEmail(payload: Record<string, unknown>): string {
  const branchName = str(payload.branchName, 'your branch');
  return renderEmailLayout({
    heading: 'New funding record awaiting your verification',
    bodyHtml: [
      paragraph(
        `A funding record of <strong>${naira(payload.amountKobo)}</strong> was recorded for ` +
          `<strong>${escapeHtml(branchName)}</strong>. Please verify or reject it in the BCKash ` +
          'Cooperative platform.',
      ),
    ].join(''),
  });
}
