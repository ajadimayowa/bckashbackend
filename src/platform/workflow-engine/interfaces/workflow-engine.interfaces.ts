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
  /**
   * Optional — added in Phase 8. Every caller before Phase 8 (Staff/Customer/Group/
   * LoanProduct/FeeDefinition) creates its domain entity only on approval, so
   * `entityId` starts null and is backfilled later via `linkEntity`. Phase 8's Loan
   * is the first entity created immediately at raise time (see
   * `modules/loans/loans.service.ts`, PHASE_8_NOTES.md for why), so it already has
   * a real id before calling `initiate` and can hand it over directly instead of a
   * separate `linkEntity` follow-up call. Omitted/undefined preserves the exact
   * prior behavior (`entityId: null`) for every existing caller.
   */
  entityId?: string | null;
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
