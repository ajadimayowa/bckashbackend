export const WORKFLOW_APPROVED_EVENT = 'workflow.approved';
export const WORKFLOW_REJECTED_EVENT = 'workflow.rejected';
export const WORKFLOW_RETURNED_EVENT = 'workflow.returned';
export const WORKFLOW_RESUBMITTED_EVENT = 'workflow.resubmitted';
// Added for GroupsService's own "a group goes PENDING while a member
// addition is under review" rule — cancelling or hard-deleting a request
// that already had a side effect (like flipping the target group's status)
// needs the same kind of "undo it" hook approval/rejection already gets.
// Neither `cancel()` nor `deleteRequest()` touch any domain entity
// themselves, so emitting these was previously skipped — see each one's own
// call site in workflow-engine.service.ts.
export const WORKFLOW_CANCELLED_EVENT = 'workflow.cancelled';
export const WORKFLOW_DELETED_EVENT = 'workflow.deleted';

interface WorkflowEventBase {
  workflowRequestId: string;
  entityType: string;
  entityId: string | null;
  action: string;
  branchId: string | null;
}

/**
 * Domain modules subscribe to this (`@OnEvent(WORKFLOW_APPROVED_EVENT)`) to
 * actually create/mutate their entity — the engine itself never knows what a
 * "Group" or "Loan" is, so it hands back the latest payload and lets the
 * subscriber interpret it.
 */
export interface WorkflowApprovedEvent extends WorkflowEventBase {
  payload: Record<string, unknown>;
  initiatedBy: string;
  /**
   * The actor who took the final APPROVED action that pushed this request
   * over the line — distinct from `initiatedBy` (the maker). Added for
   * subscribers that need to stamp "who approved this" onto the entity they
   * create (e.g. platform-config's versioned records) without a second
   * lookup back into WorkflowRequest.steps.
   */
  approvedBy: string;
}

/**
 * `payload` — same reasoning as WorkflowApprovedEvent's own: a subscriber
 * that applied some side effect at *initiation* time (not just on approval)
 * needs a way to know which domain record to undo it on, and rejection
 * carries no `entityId` (nothing was ever linked — see WorkflowEngineService
 * `linkEntity`, only ever called from an APPROVED handler).
 */
export interface WorkflowRejectedEvent extends WorkflowEventBase {
  payload: Record<string, unknown>;
  rejectedBy: string;
  comment?: string;
}

export interface WorkflowReturnedEvent extends WorkflowEventBase {
  returnedBy: string;
  comment: string;
}

export interface WorkflowResubmittedEvent extends WorkflowEventBase {
  resubmittedBy: string;
}

/** Same `payload` reasoning as WorkflowRejectedEvent's own doc comment. */
export interface WorkflowCancelledEvent extends WorkflowEventBase {
  payload: Record<string, unknown>;
  cancelledBy: string;
}

/** Same `payload` reasoning as WorkflowRejectedEvent's own doc comment — captured before the WorkflowRequest document itself is deleted. */
export interface WorkflowDeletedEvent extends WorkflowEventBase {
  payload: Record<string, unknown>;
  deletedBy: string;
}
