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
/** BranchBankAccount CRUD — deliberately not workflow-mediated, same reasoning as ORG_MANAGE_CAPABILITY. */
export const BRANCH_MANAGE_ACCOUNTS_CAPABILITY = 'branch:manage_accounts';
/** Head office recording a BranchFunding record (a two-party confirmation, not a workflow chain — see PHASE_4_NOTES.md). */
export const BRANCH_FUND_CAPABILITY = 'branch:fund';
/**
 * Coarse gate for "the kind of staff who can ever verify/reject a funding
 * record" — the specific rule ("must be *this branch's* current manager") is
 * enforced in BranchFundingService, not by this capability alone.
 */
export const BRANCH_VERIFY_FUNDING_CAPABILITY = 'branch:verify_funding';
/**
 * Gates *initiating* a GROUP/REASSIGN_LEADERSHIP request (filling a vacant
 * leadership role) — deliberately narrower than `initiateCapability(GROUP)`
 * (which MARKETER/MANAGER also hold), since this is a corrective admin action
 * with no confirmed succession policy, not routine group formation. The
 * request itself still goes through a single-step `workflow:approve:GROUP`
 * check before taking effect, so an Admin who initiates it needs a second
 * Admin/SuperAdmin/Approver to approve — see PHASE_6_NOTES.md.
 */
export const GROUP_REASSIGN_LEADERSHIP_CAPABILITY = 'group:reassign_leadership';
/**
 * Gates the operational (non-workflow) pre-disbursement steps introduced in
 * Phase 8 — `initiateMemberVerification`, a manual `checkAndDisburse` retry,
 * and `confirmChequeHandover`. None of these are maker-checker actions (see
 * PHASE_8_NOTES.md — verification outcomes aren't a proposal awaiting a
 * second approver, they're a recorded fact), so a workflow-step capability
 * doesn't fit; granted to the same roles that can raise a loan in the first
 * place (MARKETER/MANAGER/ADMIN/SUPERADMIN). `resolveEscalation` deliberately
 * uses `approveCapability(LOAN)` instead — see that method's own doc comment.
 */
export const LOAN_DISBURSEMENT_OPS_CAPABILITY = 'loan:disbursement_ops';

export const ALL_WORKFLOW_ENTITY_TYPES: readonly WorkflowEntityType[] =
  Object.values(WorkflowEntityType);

/**
 * Every capability string the system actually knows about — the three
 * workflow-step capabilities for every registered entity type, plus every
 * flat capability. Used to validate admin-supplied capability strings (e.g.
 * `LoanProduct.approvalChainSteps[].requiredCapability` — see
 * `modules/loan-products`, PHASE_7_NOTES.md) against a canonical set rather
 * than accepting arbitrary strings, so a typo can't silently create an
 * unfulfillable workflow step. Deliberately NOT the same thing as "whatever
 * capabilities happen to be assigned to some role in the DB right now" (via
 * RbacService) — a valid-but-currently-unassigned capability is fine; a
 * string that isn't in this vocabulary at all is the actual error case.
 */
export const ALL_KNOWN_CAPABILITIES: readonly string[] = [
  ...ALL_WORKFLOW_ENTITY_TYPES.flatMap((entityType) => [
    initiateCapability(entityType),
    reviewCapability(entityType),
    approveCapability(entityType),
  ]),
  STAFF_DISABLE_CAPABILITY,
  RBAC_MANAGE_CAPABILITY,
  ORG_MANAGE_CAPABILITY,
  STAFF_CREATE_DIRECT_CAPABILITY,
  BRANCH_MANAGE_ACCOUNTS_CAPABILITY,
  BRANCH_FUND_CAPABILITY,
  BRANCH_VERIFY_FUNDING_CAPABILITY,
  GROUP_REASSIGN_LEADERSHIP_CAPABILITY,
  LOAN_DISBURSEMENT_OPS_CAPABILITY,
];
