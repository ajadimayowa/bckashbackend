import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { NotificationCategory, NotificationTrigger } from '../../common/enums/notification.enums';
import {
  BRANCH_FUNDING_NUDGE_REQUESTED_EVENT,
  BRANCH_MANAGER_ASSIGNED_EVENT,
  BranchFundingNudgeRequestedEvent,
  BranchManagerAssignedEvent,
} from '../branches/events/branch.events';
import { BranchManagerAssignmentService } from '../branches/branch-manager-assignment.service';
import { BranchesService } from '../branches/branches.service';
import { StaffService } from '../identity/staff.service';
import { NotificationRecipient } from './interfaces/notification-recipient.interface';
import { NotificationService } from './notification.service';

/**
 * Listens for BranchesModule's own events that need a notification but can't
 * call `NotificationService` directly without a module import cycle
 * (NotificationsModule already imports BranchesModule for BranchesService) —
 * same decoupling shape as `IdentityEventListenersService`. Kept as its own
 * file rather than folded into that one since it's about branch-originated
 * events, not identity ones.
 */
@Injectable()
export class BranchEventListenersService {
  private readonly logger = new Logger(BranchEventListenersService.name);

  constructor(
    private readonly notificationService: NotificationService,
    private readonly branchManagerAssignmentService: BranchManagerAssignmentService,
    private readonly branchesService: BranchesService,
    private readonly staffService: StaffService,
  ) {}

  @OnEvent(BRANCH_FUNDING_NUDGE_REQUESTED_EVENT)
  async handleFundingNudgeRequested(event: BranchFundingNudgeRequestedEvent): Promise<void> {
    const currentManager = await this.branchManagerAssignmentService.getCurrentManager(event.branchId);
    if (!currentManager) {
      this.logger.warn(
        `Funding ${event.fundingId} nudge requested but branch ${event.branchId} has no current manager — nothing to send.`,
      );
      return;
    }

    const manager = await this.staffService.findById(currentManager.staffId.toString()).catch(() => null);
    if (!manager) {
      this.logger.warn(
        `Funding ${event.fundingId} nudge requested but manager ${currentManager.staffId.toString()} no longer exists.`,
      );
      return;
    }

    const recipient: NotificationRecipient = {
      kind: 'STAFF',
      id: manager._id.toString(),
      email: manager.email,
      phone: manager.phoneNumber,
    };

    const amountNaira = (event.amountKobo / 100).toLocaleString();
    await this.notificationService.dispatch(
      NotificationTrigger.FUNDING_REMINDER,
      event.fundingId,
      recipient,
      {
        details: `A ₦${amountNaira} funding record from ${new Date(event.fundedAt).toLocaleDateString()} is awaiting your verification.`,
      },
      { category: NotificationCategory.BRANCH_MANAGER, branchId: event.branchId },
    );
  }

  /** Email-only, deliberately — see BRANCH_MANAGER_ASSIGNED_EVENT/NotificationTrigger.BRANCH_MANAGER_ASSIGNED's own doc comments. */
  @OnEvent(BRANCH_MANAGER_ASSIGNED_EVENT)
  async handleManagerAssigned(event: BranchManagerAssignedEvent): Promise<void> {
    const [manager, assignedByStaff, branch] = await Promise.all([
      this.staffService.findById(event.staffId).catch(() => null),
      this.staffService.findById(event.assignedBy).catch(() => null),
      this.branchesService.findById(event.branchId).catch(() => null),
    ]);

    if (!manager) {
      this.logger.warn(
        `Branch ${event.branchId} manager assignment approved but staff ${event.staffId} no longer exists — nothing to send.`,
      );
      return;
    }

    const recipient: NotificationRecipient = {
      kind: 'STAFF',
      id: manager._id.toString(),
      email: manager.email,
      // Email-only — see this trigger's own doc comment.
      phone: null,
    };

    await this.notificationService.dispatch(
      NotificationTrigger.BRANCH_MANAGER_ASSIGNED,
      event.branchId,
      recipient,
      {
        firstName: manager.firstName,
        branchName: branch?.name ?? 'your assigned branch',
        assignedByName: assignedByStaff ? `${assignedByStaff.firstName} ${assignedByStaff.lastName}`.trim() : undefined,
      },
      { category: NotificationCategory.BRANCH_MANAGER, branchId: event.branchId },
    );
  }
}
