import { WorkflowStepAction } from '../../../common/enums/workflow.enums';

export interface WorkflowStepConfigInput {
  order: number;
  requiredCapability: string;
}

/** Passed by a domain module at init time — see WorkflowEngineService.registerChainConfig. */
export interface RegisterChainConfigInput {
  entityType: string;
  action: string;
  restartOnReturn: boolean;
  steps: WorkflowStepConfigInput[];
}

/**
 * What a controller passes into `act`/`getPendingForActor` after its own
 * StaffContextGuard has already resolved the caller's capabilities. The engine
 * never resolves capabilities itself — see PHASE_2_NOTES.md for why (Identity,
 * which maps a staffId to a role, doesn't exist until Phase 3; keeping the
 * engine capability-resolution-free also keeps it dependency-free of RBAC).
 */
export interface ActingStaff {
  staffId: string;
  capabilities: string[];
}

export interface InitiateWorkflowInput {
  entityType: string;
  action: string;
  payload: Record<string, unknown>;
  initiatedBy: string;
  branchId?: string | null;
}

export interface ActOnWorkflowInput {
  workflowRequestId: string;
  actor: ActingStaff;
  action: WorkflowStepAction;
  comment?: string;
}

export interface ResubmitWorkflowInput {
  workflowRequestId: string;
  actorId: string;
  newPayload: Record<string, unknown>;
}
