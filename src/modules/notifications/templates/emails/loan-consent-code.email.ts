import { str } from '../format.util';
import { amountCallout, escapeHtml, paragraph, renderEmailLayout } from './email-layout';

export function loanConsentCodeEmail(payload: Record<string, unknown>): string {
  const code = str(payload.code, '');

  return renderEmailLayout({
    heading: 'Confirm your loan application',
    bodyHtml: [
      paragraph(
        'A BCKash staff member is raising a loan application on your behalf. Read them this ' +
          'code to confirm you consent to it:',
      ),
      amountCallout('Consent code', escapeHtml(code)),
      paragraph(
        "This code expires shortly and can only be used once. If you didn't request or " +
          'expect this, contact your branch before sharing the code with anyone.',
      ),
    ].join(''),
  });
}
