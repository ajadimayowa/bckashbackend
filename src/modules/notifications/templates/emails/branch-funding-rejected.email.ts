import { naira, str } from '../format.util';
import { escapeHtml, paragraph, renderEmailLayout } from './email-layout';

/** Sent to a branch's assigned admins/approvers once its manager rejects a funding record (BranchFundingService.rejectFunding). */
export function branchFundingRejectedEmail(payload: Record<string, unknown>): string {
  const branchName = str(payload.branchName, 'a branch');
  const rejectedByName = str(payload.rejectedByName, 'the branch manager');
  const reason = str(payload.reason, 'no reason given');
  return renderEmailLayout({
    heading: 'Funding record rejected',
    bodyHtml: [
      paragraph(
        `${escapeHtml(rejectedByName)} rejected a <strong>${naira(payload.amountKobo)}</strong> ` +
          `funding record for <strong>${escapeHtml(branchName)}</strong>: ${escapeHtml(reason)}`,
      ),
    ].join(''),
  });
}
