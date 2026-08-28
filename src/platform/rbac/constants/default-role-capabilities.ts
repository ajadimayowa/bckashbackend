import { StaffRole } from '../../../common/enums/identity.enums';
import { WorkflowEntityType } from '../../../common/enums/workflow.enums';
import {
  ACCOUNTING_MANAGE_CAPABILITY,
  ALL_WORKFLOW_ENTITY_TYPES,
  BRANCH_FUND_CAPABILITY,
  BRANCH_MANAGE_ACCOUNTS_CAPABILITY,
  BRANCH_VERIFY_FUNDING_CAPABILITY,
  GROUP_REASSIGN_LEADERSHIP_CAPABILITY,
  HR_LEAVE_TYPES_MANAGE_CAPABILITY,
  HR_SALARY_MANAGE_CAPABILITY,
  LEAVE_CANCEL_APPROVED_CAPABILITY,
  LOAN_DISBURSEMENT_OPS_CAPABILITY,
  NOTIFICATIONS_MANAGE_CAPABILITY,
  ORG_MANAGE_CAPABILITY,
  ORGANISATION_MANAGE_CAPABILITY,
  RBAC_MANAGE_CAPABILITY,
  STAFF_CREATE_DIRECT_CAPABILITY,
  STAFF_DISABLE_CAPABILITY,
  approveCapability,
  initiateCapability,
  reviewCapability,
} from './capabilities';

/**
 * Default capability set per role, seeded into the RoleCapabilities collection at
 * boot (only if a role has no document yet — see RbacService — so this never
 * clobbers an Admin's later edits). Derived from the project brief's role
 * descriptions rather than the role name itself:
 *
 * - MARKETER: initiates records only (onboards customers, raises loans, records
 *   repayments, applies for leave). Cannot review or approve anything.
 * - MANAGER: initiates the same as MARKETER, plus initiates staff onboarding
 *   (Branch Managers onboard marketers) and reviews everything MARKETER can
 *   initiate — the "first pair of eyes" reviewer role in most chains. Also
 *   holds `approveCapability(STAFF)` (added for the Initiator/Authorizer RBAC
 *   feature) — but StaffService's PreApprovalValidator restricts this in
 *   practice to "only ever approves another Manager's own staff proposal,"
 *   never anyone else's.
 * - ADMIN: reviews + approves everything, initiates + approves loan product/fee
 *   config changes (brief: "initiated by Admin"), can disable staff accounts, and
 *   manages org structure (Department/Unit/Branch CRUD — see PHASE_3_NOTES.md
 *   for why that's a flat capability rather than workflow-mediated).
 * - SUPERADMIN: superset of ADMIN, plus `rbac:manage` (the only role that can
 *   edit this very capability matrix) and `staff:create-direct` (directly
 *   creating MANAGER/ADMIN/APPROVER accounts without the workflow engine — see
 *   PHASE_3_NOTES.md).
 * - APPROVER: approves only, across every entity type. Never initiates or reviews.
 *
 * ASSUMPTION (flagged): the brief doesn't spell out this exact matrix — it gives
 * per-module hints ("Marketer/Manager initiates, Admin/SuperAdmin/Approver
 * approves") that this generalizes into a consistent rule across all entity
 * types. Confirm before relying on this for anything beyond Phase 2's own tests;
 * it's easy to adjust later since it's DB-seeded data, not code.
 *
 * IMPORTANT (Initiator/Authorizer RBAC feature): this table alone no longer
 * decides what a given STAFF MEMBER can actually do — a role only grants the
 * *ceiling* of what someone in it could ever do. `RbacService.resolveContext`
 * additionally filters these capabilities per staff member by their own
 * `userType` (Initiator/Authorizer, see StaffUserType's own doc comment,
 * identity.enums.ts): an Initiator-flagged staff member keeps only
 * `workflow:initiate:*`; an Authorizer-flagged one keeps only
 * `workflow:review:*`/`workflow:approve:*`. Every role below still needs
 * BOTH the capability seeded here AND the matching userType on the
 * individual record to actually exercise it.
 */

const MAKER_ENTITY_TYPES: readonly WorkflowEntityType[] = [
  WorkflowEntityType.CUSTOMER,
  WorkflowEntityType.GROUP,
  WorkflowEntityType.GROUP_MEMBERSHIP,
  WorkflowEntityType.LOAN,
  WorkflowEntityType.REPAYMENT_RECORD,
  // Added in Phase 9 — same maker category as REPAYMENT_RECORD (the same
  // staff who record repayments initiate an early liquidation). Its chain is
  // single-step approve-only (see modules/repayments, PHASE_9_NOTES.md), so
  // MANAGER's resulting reviewCapability(EARLY_LIQUIDATION) grant is never
  // actually consulted by any chain — same harmless-but-unused precedent as
  // LOAN_PRODUCT/FEE_DEFINITION's existing single-step chains.
  WorkflowEntityType.EARLY_LIQUIDATION,
  WorkflowEntityType.LEAVE_APPLICATION,
];

const CONFIG_ENTITY_TYPES: readonly WorkflowEntityType[] = [
  WorkflowEntityType.LOAN_PRODUCT,
  WorkflowEntityType.FEE_DEFINITION,
  // Added in Phase 12 — Admin/SuperAdmin propose a salary change, a
  // *different* Admin/SuperAdmin approves it (single-step chain, same
  // "propose then a different admin-tier person approves" shape as
  // LOAN_PRODUCT/FEE_DEFINITION). See modules/hr, PHASE_12_NOTES.md.
  WorkflowEntityType.SALARY_RECORD,
  // Settings > Loan Configuration / Repayment & Penalties / Branch Rules —
  // same "Admin proposes, a different Admin/SuperAdmin/Approver approves"
  // single-step shape, but versioned (see modules/platform-config).
  WorkflowEntityType.LOAN_CONFIG,
  WorkflowEntityType.REPAYMENT_PENALTY_CONFIG,
  WorkflowEntityType.BRANCH_RULES_CONFIG,
  // Branch creation — grants ADMIN/SUPERADMIN initiate here; APPROVER's own
  // initiate:BRANCH is granted explicitly below since APPROVER doesn't use
  // this list (it only ever gets approve:* via ALL_WORKFLOW_ENTITY_TYPES) —
  // branch creation is the one entity type Approver can also propose, not
  // just approve, per explicit product decision.
  WorkflowEntityType.BRANCH,
  // Assigning a branch manager — same "Admin/SuperAdmin proposes, a
  // different Admin/SuperAdmin/Approver approves" shape as the rest of this
  // list; see BranchManagerAssignmentService.
  WorkflowEntityType.BRANCH_MANAGER_ASSIGNMENT,
  // Assigning an ADMIN/APPROVER to oversee one or more branches — same
  // "Admin/SuperAdmin proposes, a different Admin/SuperAdmin/Approver
  // approves" shape; see BranchStaffRoleAssignmentService.
  WorkflowEntityType.BRANCH_ROLE_ASSIGNMENT,
];

export interface RoleCapabilitiesSeed {
  role: StaffRole;
  capabilities: string[];
}

export const DEFAULT_ROLE_CAPABILITIES: readonly RoleCapabilitiesSeed[] = [
  {
    role: StaffRole.MARKETER,
    capabilities: [
      ...MAKER_ENTITY_TYPES.map((entityType) => initiateCapability(entityType)),
      // Phase 8: initiating pre-disbursement verification / a manual
      // checkAndDisburse retry / confirming cheque handover — operational,
      // not maker-checker, so a flat capability rather than a workflow-step
      // one. See capabilities.ts's own comment and PHASE_8_NOTES.md.
      LOAN_DISBURSEMENT_OPS_CAPABILITY,
    ],
  },
  {
    role: StaffRole.MANAGER,
    capabilities: [
      ...MAKER_ENTITY_TYPES.map((entityType) => initiateCapability(entityType)),
      initiateCapability(WorkflowEntityType.STAFF),
      ...[...MAKER_ENTITY_TYPES, WorkflowEntityType.STAFF].map((entityType) =>
        reviewCapability(entityType),
      ),
      // Added for the Initiator/Authorizer RBAC feature — a MANAGER-
      // initiated staff proposal needs an Authorizer pool of its own to
      // draw from (MANAGER previously held no approveCapability(STAFF) at
      // all). StaffService's registerPreApprovalValidator (STAFF/CREATE)
      // is what keeps this scoped to "only ever approves another Manager's
      // own proposal" — a Manager holding this capability still can never
      // approve a SUPERADMIN/ADMIN/APPROVER-initiated one. See
      // StaffService.onModuleInit.
      approveCapability(WorkflowEntityType.STAFF),
      // Branch managers verify/reject head-office funding for their own
      // branch — BranchFundingService additionally enforces "their own",
      // this capability only gates "a manager, generically" (see PHASE_4_NOTES.md).
      BRANCH_VERIFY_FUNDING_CAPABILITY,
      LOAN_DISBURSEMENT_OPS_CAPABILITY,
    ],
  },
  {
    role: StaffRole.ADMIN,
    capabilities: [
      ...ALL_WORKFLOW_ENTITY_TYPES.map((entityType) => reviewCapability(entityType)),
      ...ALL_WORKFLOW_ENTITY_TYPES.map((entityType) => approveCapability(entityType)),
      ...CONFIG_ENTITY_TYPES.map((entityType) => initiateCapability(entityType)),
      STAFF_DISABLE_CAPABILITY,
      ORG_MANAGE_CAPABILITY,
      // Added per explicit product decision — Admin now manages the
      // organisation profile alongside SuperAdmin, not SuperAdmin alone
      // (see OrganisationController's own doc comment).
      ORGANISATION_MANAGE_CAPABILITY,
      BRANCH_MANAGE_ACCOUNTS_CAPABILITY,
      BRANCH_FUND_CAPABILITY,
      GROUP_REASSIGN_LEADERSHIP_CAPABILITY,
      LOAN_DISBURSEMENT_OPS_CAPABILITY,
      ACCOUNTING_MANAGE_CAPABILITY,
      NOTIFICATIONS_MANAGE_CAPABILITY,
      HR_SALARY_MANAGE_CAPABILITY,
      LEAVE_CANCEL_APPROVED_CAPABILITY,
      HR_LEAVE_TYPES_MANAGE_CAPABILITY,
    ],
  },
  {
    role: StaffRole.SUPERADMIN,
    capabilities: [
      ...ALL_WORKFLOW_ENTITY_TYPES.map((entityType) => reviewCapability(entityType)),
      ...ALL_WORKFLOW_ENTITY_TYPES.map((entityType) => approveCapability(entityType)),
      ...CONFIG_ENTITY_TYPES.map((entityType) => initiateCapability(entityType)),
      STAFF_DISABLE_CAPABILITY,
      RBAC_MANAGE_CAPABILITY,
      ORG_MANAGE_CAPABILITY,
      ORGANISATION_MANAGE_CAPABILITY,
      STAFF_CREATE_DIRECT_CAPABILITY,
      // Explicit product decision — SuperAdmin can onboard staff through the
      // same workflow-mediated path Managers use (POST /staff/onboard), not
      // just the bypass-approval /staff/direct path STAFF_CREATE_DIRECT_CAPABILITY
      // already grants above.
      initiateCapability(WorkflowEntityType.STAFF),
      BRANCH_MANAGE_ACCOUNTS_CAPABILITY,
      BRANCH_FUND_CAPABILITY,
      GROUP_REASSIGN_LEADERSHIP_CAPABILITY,
      LOAN_DISBURSEMENT_OPS_CAPABILITY,
      ACCOUNTING_MANAGE_CAPABILITY,
      NOTIFICATIONS_MANAGE_CAPABILITY,
      HR_SALARY_MANAGE_CAPABILITY,
      LEAVE_CANCEL_APPROVED_CAPABILITY,
      HR_LEAVE_TYPES_MANAGE_CAPABILITY,
    ],
  },
  {
    role: StaffRole.APPROVER,
    capabilities: [
      ...ALL_WORKFLOW_ENTITY_TYPES.map((entityType) => approveCapability(entityType)),
      // See CONFIG_ENTITY_TYPES' own BRANCH comment — Approver can propose a
      // new branch too, not just approve one (a different Admin/SuperAdmin/
      // Approver still has to approve it; the maker-checker rule blocks
      // self-approval regardless of role).
      initiateCapability(WorkflowEntityType.BRANCH),
    ],
  },
];
