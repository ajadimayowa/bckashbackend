import { str } from '../format.util';
import { amountCallout, escapeHtml, paragraph, renderEmailLayout } from './email-layout';

/**
 * Sent once, right after a Staff document is created (either creation path
 * — see identity/events/staff.events.ts). `amountCallout` is reused here
 * purely for its "prominent labeled value" styling, not for money — it
 * renders the temporary password just as legibly.
 */
export function staffWelcomeEmail(payload: Record<string, unknown>): string {
  const firstName = str(payload.firstName, 'there');
  const temporaryPassword = str(payload.temporaryPassword, '');
  const email = str(payload.email, '');
  const role = str(payload.role, '');
  const departmentName = str(payload.departmentName, '');
  const branchName = str(payload.branchName, '');
  const userType = str(payload.userType, '');

  const details = [
    departmentName && `<strong>Department:</strong> ${escapeHtml(departmentName)}`,
    branchName && `<strong>Branch:</strong> ${escapeHtml(branchName)}`,
    role && `<strong>Role:</strong> ${escapeHtml(role)}`,
    userType && `<strong>Access type:</strong> ${escapeHtml(userType)}`,
  ]
    .filter(Boolean)
    .map((line) => `<p style="margin:0 0 6px;">${line}</p>`)
    .join('');

  return renderEmailLayout({
    heading: 'Welcome to BCKash Cooperative',
    bodyHtml: [
      paragraph(
        `Hi ${escapeHtml(firstName)}, an account has been created for you on the BCKash ` +
          'Cooperative platform. Here are your login details:',
      ),
      paragraph(`<strong>Email:</strong> ${escapeHtml(email)}`),
      amountCallout('Temporary password', escapeHtml(temporaryPassword)),
      paragraph(
        '<strong>You must change this password the first time you log in.</strong> ' +
          "You'll also be asked to confirm a one-time code sent to this email and your " +
          'registered phone number as a second login step.',
      ),
      details ? `<div style="margin-top:16px;">${details}</div>` : '',
    ].join(''),
  });
}
