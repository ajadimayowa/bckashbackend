import { str } from '../format.util';
import { escapeHtml, paragraph, renderEmailLayout } from './email-layout';

/** Sent by PasswordResetService.resetPassword right after a successful forgot-password reset. */
export function passwordResetConfirmationEmail(payload: Record<string, unknown>): string {
  const firstName = str(payload.firstName, 'there');

  return renderEmailLayout({
    heading: 'Your password has been changed',
    bodyHtml: [
      paragraph(
        `Hi ${escapeHtml(firstName)}, your password was just reset via the forgot-password ` +
          'flow.',
      ),
      paragraph(
        "If you made this change, no further action is needed — you've been logged out " +
          'of every other device and can log back in with your new password.',
      ),
      paragraph(
        "<strong>If you didn't request this change, contact your Admin immediately</strong> " +
          '— your account may be compromised.',
      ),
    ].join(''),
  });
}
