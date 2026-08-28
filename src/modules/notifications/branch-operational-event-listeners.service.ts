import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { NotificationCategory, NotificationTrigger } from '../../common/enums/notification.enums';
import {
  BranchFundingDisputeRaisedEvent,
  BranchFundingDisputeResolvedEvent,
  BranchFundingRecordedEvent,
  BranchFundingRejectedEvent,
  BranchFundingVerifiedEvent,
  BranchRequestRaisedEvent,
  BranchRequestResolvedEvent,
  BranchRoleAssignedEvent,
  BRANCH_FUNDING_DISPUTE_RAISED_EVENT,
  BRANCH_FUNDING_DISPUTE_RESOLVED_EVENT,
  BRANCH_FUNDING_RECORDED_EVENT,
  BRANCH_FUNDING_REJECTED_EVENT,
  BRANCH_FUNDING_VERIFIED_EVENT,
  BRANCH_REQUEST_RAISED_EVENT,
  BRANCH_REQUEST_RESOLVED_EVENT,
  BRANCH_ROLE_ASSIGNED_EVENT,
} from '../branches/events/branch.events';
import { BranchesService } from '../branches/branches.service';
import { StaffDocument } from '../identity/schemas/staff.schema';
import { StaffService } from '../identity/staff.service';
import { NotificationRecipient } from './interfaces/notification-recipient.interface';
import { NotificationService } from './notification.service';
import { BranchOperationalRecipientsResolver } from './recipient-resolution/branch-operational-recipients.resolver';

/**
 * Listens for BranchesModule's own branch-operational events (funding
 * record/verify/reject/dispute, head-office requests, and the new
 * many-to-many admin/approver assignment) and turns each into a
 * notification for the right actor — manager-tier events to the branch's
 * current manager, admin/approver-tier events to its currently-assigned
 * admins/approvers (see BranchOperationalRecipientsResolver). Kept separate
 * from the pre-existing `BranchEventListenersService` (funding nudge,
 * manager-assigned) so that file doesn't grow unwieldy — same "BranchesModule
 * emits, NotificationsModule listens" decoupling shape either way.
 */
@Injectable()
export class BranchOperationalEventListenersService {
  private readonly logger = new Logger(BranchOperationalEventListenersService.name);

  constructor(
    private readonly notificationService: NotificationService,
    private readonly recipientsResolver: BranchOperationalRecipientsResolver,
    private readonly branchesService: BranchesService,
    private readonly staffService: StaffService,
  ) {}

  private toRecipient(staff: StaffDocument): NotificationRecipient {
    return { kind: 'STAFF', id: staff._id.toString(), email: staff.email, phone: staff.phoneNumber };
  }

  private async branchName(branchId: string): Promise<string> {
    const branch = await this.branchesService.findById(branchId).catch(() => null);
    return branch?.name ?? 'a branch';
  }

  private async staffFullName(staffId: string): Promise<string | undefined> {
    const staff = await this.staffService.findById(staffId).catch(() => null);
    return staff ? `${staff.firstName} ${staff.lastName}`.trim() : undefined;
  }

  /** Dispatches one notification per resolved recipient — logs (never throws) if nobody resolved, same posture as handleFundingNudgeRequested's null-manager handling. */
  private async dispatchToAll(
    recipients: StaffDocument[],
    context: { eventLabel: string; branchId: string },
    type: NotificationTrigger,
    sourceEntityId: string,
    payload: Record<string, unknown>,
    category: NotificationCategory,
  ): Promise<void> {
    if (recipients.length === 0) {
      this.logger.warn(
        `${context.eventLabel} for branch ${context.branchId} — no recipient resolved, nothing to send.`,
      );
      return;
    }
    for (const staff of recipients) {
      await this.notificationService.dispatch(type, sourceEntityId, this.toRecipient(staff), payload, {
        category,
        branchId: context.branchId,
      });
    }
  }

  @OnEvent(BRANCH_FUNDING_RECORDED_EVENT)
  async handleFundingRecorded(event: BranchFundingRecordedEvent): Promise<void> {
    const [recipients, branchName] = await Promise.all([
      this.recipientsResolver.resolveManager(event.branchId),
      this.branchName(event.branchId),
    ]);
    await this.dispatchToAll(
      recipients,
      { eventLabel: `Funding ${event.fundingId} recorded`, branchId: event.branchId },
      NotificationTrigger.BRANCH_FUNDING_RECORDED,
      event.fundingId,
      { branchName, amountKobo: event.amountKobo },
      NotificationCategory.BRANCH_MANAGER,
    );
  }

  @OnEvent(BRANCH_FUNDING_VERIFIED_EVENT)
  async handleFundingVerified(event: BranchFundingVerifiedEvent): Promise<void> {
    const [recipients, branchName, verifiedByName] = await Promise.all([
      this.recipientsResolver.resolveAdminApprovers(event.branchId),
      this.branchName(event.branchId),
      this.staffFullName(event.verifiedBy),
    ]);
    await this.dispatchToAll(
      recipients,
      { eventLabel: `Funding ${event.fundingId} verified`, branchId: event.branchId },
      NotificationTrigger.BRANCH_FUNDING_VERIFIED,
      event.fundingId,
      { branchName, amountKobo: event.amountKobo, verifiedByName },
      NotificationCategory.BRANCH_ADMIN_APPROVER,
    );
  }

  @OnEvent(BRANCH_FUNDING_REJECTED_EVENT)
  async handleFundingRejected(event: BranchFundingRejectedEvent): Promise<void> {
    const [recipients, branchName, rejectedByName] = await Promise.all([
      this.recipientsResolver.resolveAdminApprovers(event.branchId),
      this.branchName(event.branchId),
      this.staffFullName(event.rejectedBy),
    ]);
    await this.dispatchToAll(
      recipients,
      { eventLabel: `Funding ${event.fundingId} rejected`, branchId: event.branchId },
      NotificationTrigger.BRANCH_FUNDING_REJECTED,
      event.fundingId,
      { branchName, amountKobo: event.amountKobo, rejectedByName, reason: event.reason },
      NotificationCategory.BRANCH_ADMIN_APPROVER,
    );
  }

  @OnEvent(BRANCH_FUNDING_DISPUTE_RAISED_EVENT)
  async handleFundingDisputeRaised(event: BranchFundingDisputeRaisedEvent): Promise<void> {
    const [recipients, branchName, raisedByName] = await Promise.all([
      this.recipientsResolver.resolveAdminApprovers(event.branchId),
      this.branchName(event.branchId),
      this.staffFullName(event.raisedBy),
    ]);
    await this.dispatchToAll(
      recipients,
      { eventLabel: `Funding ${event.fundingId} dispute raised`, branchId: event.branchId },
      NotificationTrigger.BRANCH_FUNDING_DISPUTE_RAISED,
      event.fundingId,
      { branchName, raisedByName, reason: event.reason },
      NotificationCategory.BRANCH_ADMIN_APPROVER,
    );
  }

  @OnEvent(BRANCH_FUNDING_DISPUTE_RESOLVED_EVENT)
  async handleFundingDisputeResolved(event: BranchFundingDisputeResolvedEvent): Promise<void> {
    const raiser = await this.staffService.findById(event.raisedBy).catch(() => null);
    if (!raiser) {
      this.logger.warn(
        `Funding ${event.fundingId} dispute resolved but staff ${event.raisedBy} no longer exists — nothing to send.`,
      );
      return;
    }
    const resolvedByName = await this.staffFullName(event.resolvedBy);
    await this.notificationService.dispatch(
      NotificationTrigger.BRANCH_FUNDING_DISPUTE_RESOLVED,
      event.fundingId,
      this.toRecipient(raiser),
      { resolution: event.resolution, note: event.note, resolvedByName },
      { category: NotificationCategory.BRANCH_MANAGER, branchId: event.branchId },
    );
  }

  @OnEvent(BRANCH_REQUEST_RAISED_EVENT)
  async handleRequestRaised(event: BranchRequestRaisedEvent): Promise<void> {
    const [recipients, branchName, raisedByName] = await Promise.all([
      this.recipientsResolver.resolveAdminApprovers(event.branchId),
      this.branchName(event.branchId),
      this.staffFullName(event.raisedBy),
    ]);
    await this.dispatchToAll(
      recipients,
      { eventLabel: `Request ${event.requestId} raised`, branchId: event.branchId },
      NotificationTrigger.BRANCH_REQUEST_RAISED,
      event.requestId,
      { branchName, raisedByName, subject: event.subject },
      NotificationCategory.BRANCH_ADMIN_APPROVER,
    );
  }

  @OnEvent(BRANCH_REQUEST_RESOLVED_EVENT)
  async handleRequestResolved(event: BranchRequestResolvedEvent): Promise<void> {
    const raiser = await this.staffService.findById(event.raisedBy).catch(() => null);
    if (!raiser) {
      this.logger.warn(
        `Request ${event.requestId} resolved but staff ${event.raisedBy} no longer exists — nothing to send.`,
      );
      return;
    }
    const resolvedByName = await this.staffFullName(event.resolvedBy);
    await this.notificationService.dispatch(
      NotificationTrigger.BRANCH_REQUEST_RESOLVED,
      event.requestId,
      this.toRecipient(raiser),
      { subject: event.subject, note: event.note, resolvedByName },
      { category: NotificationCategory.BRANCH_MANAGER, branchId: event.branchId },
    );
  }

  /** Fans out one notification per branch in the approved batch — see BranchRoleAssignedEvent's own doc comment. */
  @OnEvent(BRANCH_ROLE_ASSIGNED_EVENT)
  async handleRoleAssigned(event: BranchRoleAssignedEvent): Promise<void> {
    const [assignee, assignedByName] = await Promise.all([
      this.staffService.findById(event.staffId).catch(() => null),
      this.staffFullName(event.assignedBy),
    ]);
    if (!assignee) {
      this.logger.warn(
        `Branch role assignment approved but staff ${event.staffId} no longer exists — nothing to send.`,
      );
      return;
    }

    for (const branchId of event.branchIds) {
      const branchName = await this.branchName(branchId);
      await this.notificationService.dispatch(
        NotificationTrigger.BRANCH_ROLE_ASSIGNMENT_ASSIGNED,
        branchId,
        this.toRecipient(assignee),
        { branchName, role: event.role, assignedByName },
        { category: NotificationCategory.BRANCH_ADMIN_APPROVER, branchId },
      );
    }
  }
}
