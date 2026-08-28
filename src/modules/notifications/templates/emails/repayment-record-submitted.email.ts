import { naira, str } from '../format.util';
import { escapeHtml, paragraph, renderEmailLayout } from './email-layout';

/** Sent to a branch's current manager right after a marketer records a repayment (RepaymentsService.recordRepayment) — the REPAYMENT_RECORD workflow's first (review) step is theirs to act on. */
export function repaymentRecordSubmittedEmail(payload: Record<string, unknown>): string {
  const branchName = str(payload.branchName, 'your branch');
  const recordedByName = str(payload.recordedByName, 'a marketer');
  return renderEmailLayout({
    heading: 'New repayment awaiting your review',
    bodyHtml: [
      paragraph(
        `A repayment of <strong>${naira(payload.amountKobo)}</strong> was recorded by ` +
          `<strong>${escapeHtml(recordedByName)}</strong> for <strong>${escapeHtml(branchName)}</strong>. ` +
          'Please review it in the BCKash Cooperative platform.',
      ),
    ].join(''),
  });
}
