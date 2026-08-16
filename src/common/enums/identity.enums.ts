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
