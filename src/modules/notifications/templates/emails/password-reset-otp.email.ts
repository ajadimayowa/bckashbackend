import { str } from '../format.util';
import { amountCallout, escapeHtml, paragraph, renderEmailLayout } from './email-layout';

/** Sent by PasswordResetService.requestReset — the forgot-password flow's code step. */
export function passwordResetOtpEmail(payload: Record<string, unknown>): string {
  const firstName = str(payload.firstName, 'there');
  const code = str(payload.code, '');

  return renderEmailLayout({
    heading: 'Reset your password',
    bodyHtml: [
      paragraph(
        `Hi ${escapeHtml(firstName)}, we received a request to reset your password. Use ` +
          'this code to continue:',
      ),
      amountCallout('Password reset code', escapeHtml(code)),
      paragraph(
        "This code expires shortly and can only be used once. If you didn't request a " +
          'password reset, you can ignore this email — your password has not been changed.',
      ),
    ].join(''),
  });
}
