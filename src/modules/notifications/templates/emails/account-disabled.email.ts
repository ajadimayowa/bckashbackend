import { str } from '../format.util';
import { escapeHtml, paragraph, renderEmailLayout } from './email-layout';

/**
 * Sent right after `StaffService.disable` flips a staff member's status to
 * DISABLED (see identity/events/staff.events.ts — STAFF_DISABLED_EVENT).
 * `disabledByName` is resolved by IdentityEventListenersService before
 * this renders — the event itself only carries the disabling staff
 * member's id, not their name (see that event's own doc comment).
 */
export function accountDisabledEmail(payload: Record<string, unknown>): string {
  const firstName = str(payload.firstName, 'there');
  const reason = str(payload.reason, 'unspecified');
  const disabledByName = str(payload.disabledByName, 'An administrator');

  return renderEmailLayout({
    heading: 'Your account has been disabled',
    bodyHtml: [
      paragraph(`Hi ${escapeHtml(firstName)}, your staff account has been disabled.`),
      paragraph(`<strong>Reason:</strong> ${escapeHtml(reason)}`),
      paragraph(`<strong>Disabled by:</strong> ${escapeHtml(disabledByName)}`),
      paragraph(
        'You will not be able to log in while your account is disabled. If you believe ' +
          'this was done in error, contact your Admin for details.',
      ),
    ].join(''),
  });
}
