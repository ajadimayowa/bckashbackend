import { WorkflowEntityType } from '../../../common/enums/workflow.enums';

/**
 * Capability naming convention: `workflow:<step>:<entityType>` for the three
 * workflow step actions, plus a handful of flat, non-workflow capabilities.
 * `entityType` here matches WorkflowEntityType — capabilities are scoped to an
 * entity type as a whole, not to a specific (entityType, action) chain, so the
 * same "workflow:approve:LOAN" capability covers approving a loan application
 * and (if a separate chain is registered) approving a loan disbursement.
 */
export function initiateCapability(entityType: string): string {
  return `workflow:initiate:${entityType}`;
}

export function reviewCapability(entityType: string): string {
  return `workflow:review:${entityType}`;
}

export function approveCapability(entityType: string): string {
  return `workflow:approve:${entityType}`;
}

/** Flat capabilities not tied to a workflow entity type. */
export const STAFF_DISABLE_CAPABILITY = 'staff:disable';
export const RBAC_MANAGE_CAPABILITY = 'rbac:manage';
/** Department/Unit/Branch CRUD — deliberately not workflow-mediated, see PHASE_3_NOTES.md. */
export const ORG_MANAGE_CAPABILITY = 'org:manage';
/** SuperAdmin directly creating a MANAGER/ADMIN/APPROVER account, bypassing the workflow engine. */
export const STAFF_CREATE_DIRECT_CAPABILITY = 'staff:create-direct';

export const ALL_WORKFLOW_ENTITY_TYPES: readonly WorkflowEntityType[] =
  Object.values(WorkflowEntityType);
