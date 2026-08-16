export enum WorkflowStatus {
  PENDING_REVIEW = 'PENDING_REVIEW',
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  RETURNED_TO_MAKER = 'RETURNED_TO_MAKER',
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
  LEAVE_APPLICATION = 'LEAVE_APPLICATION',
}
