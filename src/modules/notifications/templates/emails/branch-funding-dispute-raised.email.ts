import { str } from '../format.util';
import { escapeHtml, paragraph, renderEmailLayout } from './email-layout';

/** Sent to a branch's assigned admins/approvers when its manager disputes a funding record (BranchFundingService.raiseDispute). */
export function branchFundingDisputeRaisedEmail(payload: Record<string, unknown>): string {
  const branchName = str(payload.branchName, 'a branch');
  const raisedByName = str(payload.raisedByName, 'the branch manager');
  const reason = str(payload.reason, 'no reason given');
  return renderEmailLayout({
    heading: 'Funding dispute raised',
    bodyHtml: [
      paragraph(
        `${escapeHtml(raisedByName)} disputed a funding record for <strong>${escapeHtml(branchName)}</strong>: ` +
          escapeHtml(reason),
      ),
    ].join(''),
  });
}
