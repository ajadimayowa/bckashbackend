export const WORKFLOW_APPROVED_EVENT = 'workflow.approved';
export const WORKFLOW_REJECTED_EVENT = 'workflow.rejected';
export const WORKFLOW_RETURNED_EVENT = 'workflow.returned';
export const WORKFLOW_RESUBMITTED_EVENT = 'workflow.resubmitted';

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
}

export interface WorkflowRejectedEvent extends WorkflowEventBase {
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
