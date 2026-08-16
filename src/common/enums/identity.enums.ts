/**
 * Staff's level of authority. Never branch business logic on this enum directly —
 * check an explicit capability (see platform/rbac) instead, so "what a role can do"
 * stays declarative and auditable in one place rather than scattered across `if`s.
 */
export enum StaffRole {
  MARKETER = 'MARKETER',
  MANAGER = 'MANAGER',
  ADMIN = 'ADMIN',
  SUPERADMIN = 'SUPERADMIN',
  APPROVER = 'APPROVER',
}

/**
 * Module access is a separate dimension from role — a Staff document carries an
 * explicit array of these, checked independently of StaffRole by the RBAC guard.
 */
export enum ModuleName {
  LOANS = 'LOANS',
  ACCOUNTING = 'ACCOUNTING',
  HR = 'HR',
}

/**
 * PENDING_APPROVAL: onboarding WorkflowRequest is in flight — no live Staff
 * record exists yet at this point (the engine only creates one on approval), so
 * in practice a Staff document only ever starts life as ACTIVE (workflow-approved)
 * or is created directly as ACTIVE (SuperAdmin direct creation). REJECTED is kept
 * for symmetry/documentation of the state space, but since a rejected onboarding
 * never creates a Staff document either, no Staff document ever actually holds
 * PENDING_APPROVAL or REJECTED today — flagging in case a future phase wants a
 * placeholder record instead of "nothing" while a request is in flight.
 */
export enum StaffStatus {
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  ACTIVE = 'ACTIVE',
  DISABLED = 'DISABLED',
  REJECTED = 'REJECTED',
}
