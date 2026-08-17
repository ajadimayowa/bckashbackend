/** Per the brief's own schema sketch — see modules/hr, PHASE_12_NOTES.md. */
export enum LeaveApplicationStatus {
  PENDING_REVIEW = 'PENDING_REVIEW',
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  RETURNED_TO_MAKER = 'RETURNED_TO_MAKER',
  CANCELLED = 'CANCELLED',
}

/**
 * Which of the three dynamically-selected leave approval chains an
 * application was routed through — see LeaveApplicationService.applyForLeave
 * and PHASE_12_NOTES.md for the full routing logic.
 */
export enum LeaveChainAction {
  APPROVE_STAFF = 'APPROVE_STAFF',
  APPROVE_MANAGER = 'APPROVE_MANAGER',
  APPROVE_ADMIN = 'APPROVE_ADMIN',
}
