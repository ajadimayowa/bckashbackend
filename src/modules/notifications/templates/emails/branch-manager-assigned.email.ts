import { str } from '../format.util';
import { escapeHtml, paragraph, renderEmailLayout } from './email-layout';

/**
 * Sent once, right after a branch manager assignment proposal is approved
 * and applied (see BranchManagerAssignmentService, BranchEventListenersService).
 */
export function branchManagerAssignedEmail(payload: Record<string, unknown>): string {
  const firstName = str(payload.firstName, 'there');
  const branchName = str(payload.branchName, 'your assigned branch');
  const assignedByName = str(payload.assignedByName, 'an administrator');

  return renderEmailLayout({
    heading: 'You have been assigned as a Branch Manager',
    bodyHtml: [
      paragraph(
        `Hi ${escapeHtml(firstName)}, you have been assigned as the Branch Manager of ` +
          `<strong>${escapeHtml(branchName)}</strong>, proposed by ${escapeHtml(assignedByName)}.`,
      ),
      paragraph(
        'You now have oversight of this branch — including its funding, staff, and day-to-day ' +
          'operations. Log in to the BCKash Cooperative platform to get started.',
      ),
    ].join(''),
  });
}
