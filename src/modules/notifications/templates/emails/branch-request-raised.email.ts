import { str } from '../format.util';
import { escapeHtml, paragraph, renderEmailLayout } from './email-layout';

/** Sent to a branch's assigned admins/approvers when its manager raises a request to head office (BranchRequestsService.create) — this leg previously sent no notification at all. */
export function branchRequestRaisedEmail(payload: Record<string, unknown>): string {
  const branchName = str(payload.branchName, 'a branch');
  const raisedByName = str(payload.raisedByName, 'the branch manager');
  const subject = str(payload.subject, 'a request');
  return renderEmailLayout({
    heading: 'New request from a branch',
    bodyHtml: [
      paragraph(
        `${escapeHtml(raisedByName)} at <strong>${escapeHtml(branchName)}</strong> raised: ` +
          `<strong>${escapeHtml(subject)}</strong>. Review it in the BCKash Cooperative platform.`,
      ),
    ].join(''),
  });
}
