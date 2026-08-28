import { str } from '../format.util';
import { escapeHtml, paragraph, renderEmailLayout } from './email-layout';

export function verificationEscalatedEmail(payload: Record<string, unknown>): string {
  const loanId = str(payload.loanId, '');
  const reason = str(payload.reason, 'unspecified');
  return renderEmailLayout({
    heading: 'Loan verification requires attention',
    bodyHtml: [
      paragraph(
        `Verification for loan <strong>${escapeHtml(loanId)}</strong> has been escalated for review.`,
      ),
      paragraph(`Reason: ${escapeHtml(reason)}`),
    ].join(''),
  });
}
