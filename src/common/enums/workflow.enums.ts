export enum WorkflowStatus {
  PENDING_REVIEW = 'PENDING_REVIEW',
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  RETURNED_TO_MAKER = 'RETURNED_TO_MAKER',
  // The maker withdrew their own proposal before anyone acted on it (or
  // after a REJECTED/RETURNED_TO_MAKER outcome they've decided not to
  // pursue) — a maker-initiated terminal state, distinct from a reviewer's
  // REJECTED. See WorkflowEngineService.cancel.
  CANCELLED = 'CANCELLED',
}

/** Action a staff member takes on a WorkflowRequest at its current step. */
export enum WorkflowStepAction {
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  RETURNED = 'RETURNED',
}

/**
 * The workflow engine itself treats `entityType`/`action` as opaque strings — it
 * never branches on what a "GROUP" or "LOAN" is (see platform/workflow-engine).
 * This is just a shared vocabulary so domain modules register chains under
 * consistent names instead of each inventing their own spelling, and so RBAC's
 * capability seed data (`workflow:review:<entityType>`) has something concrete to
 * reference. Non-exhaustive by design — a module can register a chain under a new
 * entityType without touching this file or the engine.
 */
export enum WorkflowEntityType {
  STAFF = 'STAFF',
  CUSTOMER = 'CUSTOMER',
  GROUP = 'GROUP',
  // Adding/removing a member from an already-approved Group — a distinct
  // entity type/action from GROUP/CREATE, its own two-step chain. See
  // PHASE_6_NOTES.md.
  GROUP_MEMBERSHIP = 'GROUP_MEMBERSHIP',
  LOAN = 'LOAN',
  LOAN_PRODUCT = 'LOAN_PRODUCT',
  FEE_DEFINITION = 'FEE_DEFINITION',
  REPAYMENT_RECORD = 'REPAYMENT_RECORD',
  // Added in Phase 9 — a single-step chain, distinct from REPAYMENT_RECORD's
  // two-step chain. See modules/repayments, PHASE_9_NOTES.md.
  EARLY_LIQUIDATION = 'EARLY_LIQUIDATION',
  LEAVE_APPLICATION = 'LEAVE_APPLICATION',
  // Added in Phase 10 — a single-step chain for free-form manual journal
  // entries. See modules/accounting, PHASE_10_NOTES.md.
  MANUAL_JOURNAL_ENTRY = 'MANUAL_JOURNAL_ENTRY',
  // Added in Phase 12 — a single-step chain (Admin proposes, a different
  // Admin/SuperAdmin approves) for salary structure changes. See
  // modules/hr, PHASE_12_NOTES.md.
  SALARY_RECORD = 'SALARY_RECORD',
  // Added for the Settings > Loan Rules / Branch Rules tabs — same
  // single-step "Admin proposes, a different Admin/SuperAdmin/Approver
  // approves" shape as LOAN_PRODUCT/FEE_DEFINITION/SALARY_RECORD, but the
  // domain document itself is *versioned* rather than edited in place: each
  // approved proposal becomes its own new record, and the previously-ACTIVE
  // record (if any) is flipped to INACTIVE — "the latest active one is the
  // active one". See modules/platform-config.
  LOAN_CONFIG = 'LOAN_CONFIG',
  REPAYMENT_PENALTY_CONFIG = 'REPAYMENT_PENALTY_CONFIG',
  BRANCH_RULES_CONFIG = 'BRANCH_RULES_CONFIG',
  // Added for branch creation approval — single-step chain, but unlike
  // LOAN_CONFIG/etc's CONFIG_ENTITY_TYPES (ADMIN/SUPERADMIN-initiated only),
  // Approver initiates this too — see default-role-capabilities.ts.
  BRANCH = 'BRANCH',
  // Added for assigning a branch manager — same single-step "Admin/SuperAdmin
  // proposes, a different Admin/SuperAdmin/Approver approves" shape as
  // LOAN_CONFIG/SALARY_RECORD (CONFIG_ENTITY_TYPES), not BRANCH's own
  // Approver-can-also-initiate carve-out. See BranchManagerAssignmentService.
  BRANCH_MANAGER_ASSIGNMENT = 'BRANCH_MANAGER_ASSIGNMENT',
  // Added for assigning an ADMIN/APPROVER to oversee one or more branches —
  // same single-step "Admin/SuperAdmin proposes, a different Admin/SuperAdmin/
  // Approver approves" shape as BRANCH_MANAGER_ASSIGNMENT, but many-to-many
  // (one staff member can cover many branches, one branch can have many
  // admins/approvers) rather than BRANCH_MANAGER_ASSIGNMENT's single-active-
  // row-per-branch model, and the proposal's payload always covers a whole
  // batch of branchIds at once (one approval decision applies to all of
  // them). See BranchStaffRoleAssignmentService.
  BRANCH_ROLE_ASSIGNMENT = 'BRANCH_ROLE_ASSIGNMENT',
}
