export const BRANCH_CREATED_EVENT = 'branch.created';

export interface BranchCreatedEvent {
  branchId: string;
}

export const BRANCH_FUNDING_NUDGE_REQUESTED_EVENT = 'branch.funding.nudge_requested';

/**
 * Emitted by `BranchFundingService.nudgeManager` — NotificationsModule's own
 * listener (not BranchesModule) turns this into the actual FUNDING_REMINDER
 * email/SMS to the branch's *current* manager. BranchesModule deliberately
 * never imports NotificationsModule directly (NotificationsModule already
 * imports BranchesModule for BranchesService, so the reverse import would be
 * circular) — same decoupling shape as STAFF_CREATED_EVENT/BRANCH_CREATED_EVENT.
 */
export interface BranchFundingNudgeRequestedEvent {
  fundingId: string;
  branchId: string;
  /** Kobo — integer, never a float (project-wide convention). */
  amountKobo: number;
  fundedAt: string;
  nudgedBy: string;
}

export const BRANCH_MANAGER_ASSIGNED_EVENT = 'branch.manager.assigned';

/**
 * Emitted by `BranchManagerAssignmentService`'s WORKFLOW_APPROVED_EVENT
 * handler, once a manager assignment proposal is actually approved and
 * applied — NotificationsModule's own listener (not BranchesModule) turns
 * this into the BRANCH_MANAGER_ASSIGNED email to the newly-assigned
 * manager. Same decoupling shape as BranchFundingNudgeRequestedEvent above:
 * kept id-only (no resolved names) — the listener re-resolves the staff/
 * branch records itself via BranchesModule's own exported services.
 */
export interface BranchManagerAssignedEvent {
  branchId: string;
  /** The staff member newly assigned as manager — who the email goes to. */
  staffId: string;
  assignedBy: string;
  approvedBy: string;
}

export const BRANCH_ROLE_ASSIGNED_EVENT = 'branch.role_assignment.assigned';

/**
 * Emitted by `BranchStaffRoleAssignmentService`'s WORKFLOW_APPROVED_EVENT
 * handler once an ADMIN/APPROVER batch coverage proposal is approved and
 * applied — carries the whole approved batch in one event (unlike
 * BranchManagerAssignedEvent, which is always exactly one branch).
 * NotificationsModule's own listener fans this out into one notification
 * per branch to the newly-assigned staff member.
 */
export interface BranchRoleAssignedEvent {
  /** The staff member newly assigned coverage — who the notification(s) go to. */
  staffId: string;
  branchIds: string[];
  role: 'ADMIN' | 'APPROVER';
  assignedBy: string;
  approvedBy: string;
}

// ---------------------------------------------------------------------------
// Branch-operational events for the in-app notification bell — see
// NotificationsModule's own BranchOperationalEventListenersService, which
// turns each of these into a notification for the branch's manager and/or
// its assigned admins/approvers (see BranchOperationalRecipientsResolver).
// Same "BranchesModule emits, NotificationsModule listens" decoupling shape
// as every other event on this file.
// ---------------------------------------------------------------------------

export const BRANCH_FUNDING_RECORDED_EVENT = 'branch.funding.recorded';

/** Emitted by `BranchFundingService.recordFunding` — tells the branch's current manager a new record is awaiting their verification. */
export interface BranchFundingRecordedEvent {
  fundingId: string;
  branchId: string;
  amountKobo: number;
  fundedAt: string;
  recordedBy: string;
}

export const BRANCH_FUNDING_VERIFIED_EVENT = 'branch.funding.verified';

/** Emitted by `BranchFundingService.verifyFunding` — tells the branch's assigned admins/approvers a manager has confirmed a funding record. */
export interface BranchFundingVerifiedEvent {
  fundingId: string;
  branchId: string;
  amountKobo: number;
  verifiedBy: string;
}

export const BRANCH_FUNDING_REJECTED_EVENT = 'branch.funding.rejected';

/** Emitted by `BranchFundingService.rejectFunding` — tells the branch's assigned admins/approvers a manager rejected a funding record. */
export interface BranchFundingRejectedEvent {
  fundingId: string;
  branchId: string;
  amountKobo: number;
  rejectedBy: string;
  reason: string;
}

export const BRANCH_FUNDING_DISPUTE_RAISED_EVENT = 'branch.funding.dispute_raised';

/** Emitted by `BranchFundingService.raiseDispute` — tells the branch's assigned admins/approvers a manager disputed a funding record. */
export interface BranchFundingDisputeRaisedEvent {
  fundingId: string;
  branchId: string;
  raisedBy: string;
  reason: string;
}

export const BRANCH_FUNDING_DISPUTE_RESOLVED_EVENT = 'branch.funding.dispute_resolved';

/** Emitted by `BranchFundingService.resolveDispute` — tells the manager who originally raised the dispute how it was resolved. */
export interface BranchFundingDisputeResolvedEvent {
  fundingId: string;
  branchId: string;
  /** Who raised the original dispute — who the resolution notification goes to. */
  raisedBy: string;
  resolvedBy: string;
  resolution: 'RESOLVED' | 'DISMISSED';
  note: string;
}

export const BRANCH_REQUEST_RAISED_EVENT = 'branch.request.raised';

/** Emitted by `BranchRequestsService.create` — tells the branch's assigned admins/approvers a manager raised a request to head office. This leg previously sent no notification at all. */
export interface BranchRequestRaisedEvent {
  requestId: string;
  branchId: string;
  raisedBy: string;
  subject: string;
}

export const BRANCH_REQUEST_RESOLVED_EVENT = 'branch.request.resolved';

/** Emitted by `BranchRequestsService.resolve` — tells the specific manager who raised the request how it was resolved (not a fresh "current manager" lookup — they may have moved on since). This leg previously sent no notification at all. */
export interface BranchRequestResolvedEvent {
  requestId: string;
  branchId: string;
  raisedBy: string;
  resolvedBy: string;
  subject: string;
  note: string;
}
