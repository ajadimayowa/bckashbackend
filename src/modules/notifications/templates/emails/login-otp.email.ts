import { str } from '../format.util';
import { amountCallout, escapeHtml, paragraph, renderEmailLayout } from './email-layout';

export function loginOtpEmail(payload: Record<string, unknown>): string {
  const firstName = str(payload.firstName, 'there');
  const code = str(payload.code, '');

  return renderEmailLayout({
    heading: 'Your login code',
    bodyHtml: [
      paragraph(`Hi ${escapeHtml(firstName)}, use this code to finish logging in:`),
      amountCallout('One-time code', escapeHtml(code)),
      paragraph(
        "This code expires shortly and can only be used once. If you didn't try to log " +
          'in, you can ignore this email — your account is still secure.',
      ),
    ].join(''),
  });
}
