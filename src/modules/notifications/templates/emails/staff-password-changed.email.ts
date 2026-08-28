import { str } from '../format.util';
import { escapeHtml, paragraph, renderEmailLayout } from './email-layout';

/**
 * Sent right after `StaffService.changePassword` — the self-service,
 * already-logged-in path (current password required). Deliberately worded
 * differently from `passwordResetConfirmationEmail` (the no-login
 * forgot-password path), which this is not.
 */
export function staffPasswordChangedEmail(payload: Record<string, unknown>): string {
  const firstName = str(payload.firstName, 'there');

  return renderEmailLayout({
    heading: 'Your password has been changed',
    bodyHtml: [
      paragraph(`Hi ${escapeHtml(firstName)}, your password was just changed.`),
      paragraph(
        "If you made this change, no further action is needed — you've been logged out " +
          'of every other device and can log back in with your new password.',
      ),
      paragraph(
        "<strong>If you didn't make this change, contact your Admin immediately</strong> " +
          '— your account may be compromised.',
      ),
    ].join(''),
  });
}
