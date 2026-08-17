import { Injectable } from '@nestjs/common';

import { StaffRole } from '../../../common/enums/identity.enums';
import { BranchManagerAssignmentService } from '../../branches/branch-manager-assignment.service';
import { StaffService } from '../../identity/staff.service';
import { WorkflowEngineService } from '../../../platform/workflow-engine/workflow-engine.service';
import { NotificationRecipient } from '../interfaces/notification-recipient.interface';

export interface ResolveInvolvedPartiesContext {
  branchId: string;
  /** The marketer/staff who raised the loan or recorded the repayment. */
  initiatedBy: string;
  /** The original approval chain for the entity in question, if one exists. */
  relatedWorkflowRequestId?: string;
}

const ADMIN_ROLES: readonly StaffRole[] = [StaffRole.ADMIN, StaffRole.SUPERADMIN];

/**
 * Staff-facing notifications (verification escalations, repayment disputes)
 * notify the specific parties involved in that particular case, not a
 * generic role broadcast — see PHASE_11_NOTES.md. Built once, shared by both
 * trigger points (Phase 8's verification escalation, Phase 9's repayment
 * dispute retrofit) — the "involved parties" concept is identical in both,
 * only `relatedWorkflowRequestId`'s source differs (the LOAN approval chain
 * vs. the REPAYMENT_RECORD one).
 */
@Injectable()
export class InvolvedPartiesResolver {
  constructor(
    private readonly branchManagerAssignmentService: BranchManagerAssignmentService,
    private readonly workflowEngineService: WorkflowEngineService,
    private readonly staffService: StaffService,
  ) {}

  async resolveInvolvedParties(context: ResolveInvolvedPartiesContext): Promise<string[]> {
    const recipients = new Set<string>();
    recipients.add(context.initiatedBy);

    const currentManager = await this.branchManagerAssignmentService.getCurrentManager(
      context.branchId,
    );
    if (currentManager) {
      recipients.add(currentManager.staffId.toString());
    }

    if (context.relatedWorkflowRequestId) {
      const request = await this.workflowEngineService.getById(context.relatedWorkflowRequestId);
      const actedByIds = request.steps
        .filter((step) => step.actedBy !== null)
        .map((step) => step.actedBy as string);
      if (actedByIds.length > 0) {
        const actedByStaff = await this.staffService.findByIds(actedByIds);
        for (const staff of actedByStaff) {
          if (ADMIN_ROLES.includes(staff.role)) {
            recipients.add(staff._id.toString());
          }
        }
      }
    }

    // Fallback: if no Admin/SuperAdmin has acted yet on the related request
    // (e.g. an escalation fires before any review step completes), broadcast
    // to active Admin/SuperAdmin at this branch instead of leaving the case
    // with no admin-level recipient at all.
    const currentRecipients = await this.staffService.findByIds([...recipients]);
    const hasAdminRecipient = currentRecipients.some((staff) => ADMIN_ROLES.includes(staff.role));
    if (!hasAdminRecipient) {
      const branchAdmins = await this.staffService.findActiveByRoleAndBranch(
        [...ADMIN_ROLES],
        context.branchId,
      );
      for (const admin of branchAdmins) {
        recipients.add(admin._id.toString());
      }
    }

    return [...recipients];
  }

  /** Builds the STAFF-kind NotificationRecipient for one resolved staff id — used by RealNotificationPort's dispatchToStaff. */
  async resolveStaffRecipient(staffId: string): Promise<NotificationRecipient> {
    const staff = await this.staffService.findById(staffId);
    return {
      kind: 'STAFF',
      id: staffId,
      email: staff.email,
      phone: staff.phoneNumber,
    };
  }
}
