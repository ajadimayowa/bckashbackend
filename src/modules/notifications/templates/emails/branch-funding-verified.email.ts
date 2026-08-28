import { naira, str } from '../format.util';
import { escapeHtml, paragraph, renderEmailLayout } from './email-layout';

/** Sent to a branch's assigned admins/approvers once its manager verifies a funding record (BranchFundingService.verifyFunding). */
export function branchFundingVerifiedEmail(payload: Record<string, unknown>): string {
  const branchName = str(payload.branchName, 'a branch');
  const verifiedByName = str(payload.verifiedByName, 'the branch manager');
  return renderEmailLayout({
    heading: 'Funding record verified',
    bodyHtml: [
      paragraph(
        `${escapeHtml(verifiedByName)} verified a <strong>${naira(payload.amountKobo)}</strong> ` +
          `funding record for <strong>${escapeHtml(branchName)}</strong>.`,
      ),
    ].join(''),
  });
}
