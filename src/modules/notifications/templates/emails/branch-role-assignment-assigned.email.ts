import { str } from '../format.util';
import { escapeHtml, paragraph, renderEmailLayout } from './email-layout';

/** Sent once per branch in the approved batch (see BranchStaffRoleAssignmentService, BRANCH_ROLE_ASSIGNED_EVENT). */
export function branchRoleAssignmentAssignedEmail(payload: Record<string, unknown>): string {
  const branchName = str(payload.branchName, 'a branch');
  const role = str(payload.role, 'ADMIN');
  const assignedByName = str(payload.assignedByName, 'an administrator');
  return renderEmailLayout({
    heading: `You've been assigned to ${branchName}`,
    bodyHtml: [
      paragraph(
        `You are now an assigned <strong>${escapeHtml(role)}</strong> for <strong>${escapeHtml(branchName)}</strong>, ` +
          `proposed by ${escapeHtml(assignedByName)}.`,
      ),
    ].join(''),
  });
}
