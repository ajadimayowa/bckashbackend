import { StaffRole } from '../../../common/enums/identity.enums';
import { WorkflowEntityType } from '../../../common/enums/workflow.enums';
import {
  ALL_WORKFLOW_ENTITY_TYPES,
  BRANCH_FUND_CAPABILITY,
  BRANCH_MANAGE_ACCOUNTS_CAPABILITY,
  BRANCH_VERIFY_FUNDING_CAPABILITY,
  ORG_MANAGE_CAPABILITY,
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
 *   initiate — the "first pair of eyes" reviewer role in most chains.
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
 */

const MAKER_ENTITY_TYPES: readonly WorkflowEntityType[] = [
  WorkflowEntityType.CUSTOMER,
  WorkflowEntityType.GROUP,
  WorkflowEntityType.LOAN,
  WorkflowEntityType.REPAYMENT_RECORD,
  WorkflowEntityType.LEAVE_APPLICATION,
];

const CONFIG_ENTITY_TYPES: readonly WorkflowEntityType[] = [
  WorkflowEntityType.LOAN_PRODUCT,
  WorkflowEntityType.FEE_DEFINITION,
];

export interface RoleCapabilitiesSeed {
  role: StaffRole;
  capabilities: string[];
}

export const DEFAULT_ROLE_CAPABILITIES: readonly RoleCapabilitiesSeed[] = [
  {
    role: StaffRole.MARKETER,
    capabilities: MAKER_ENTITY_TYPES.map((entityType) => initiateCapability(entityType)),
  },
  {
    role: StaffRole.MANAGER,
    capabilities: [
      ...MAKER_ENTITY_TYPES.map((entityType) => initiateCapability(entityType)),
      initiateCapability(WorkflowEntityType.STAFF),
      ...[...MAKER_ENTITY_TYPES, WorkflowEntityType.STAFF].map((entityType) =>
        reviewCapability(entityType),
      ),
      // Branch managers verify/reject head-office funding for their own
      // branch — BranchFundingService additionally enforces "their own",
      // this capability only gates "a manager, generically" (see PHASE_4_NOTES.md).
      BRANCH_VERIFY_FUNDING_CAPABILITY,
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
      BRANCH_MANAGE_ACCOUNTS_CAPABILITY,
      BRANCH_FUND_CAPABILITY,
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
      STAFF_CREATE_DIRECT_CAPABILITY,
      BRANCH_MANAGE_ACCOUNTS_CAPABILITY,
      BRANCH_FUND_CAPABILITY,
    ],
  },
  {
    role: StaffRole.APPROVER,
    capabilities: ALL_WORKFLOW_ENTITY_TYPES.map((entityType) => approveCapability(entityType)),
  },
];
