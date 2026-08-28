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
 * A staff member's function in an approval chain — supplied by the caller
 * at creation time (see CreateStaffDirectDto/InitiateStaffOnboardingDto),
 * stored on Staff, independent of `role`.
 *
 * REAL ACCESS CONTROL, not just display (Initiator/Authorizer RBAC feature)
 * — `RbacService.resolveContext` filters a staff member's role-derived
 * capabilities by this field on every request: INITIATOR keeps only
 * `workflow:initiate:*`; AUTHORIZER keeps only `workflow:review:*`/
 * `workflow:approve:*`. A staff member holds exactly one of these two going
 * forward — see `StaffService.resolveUserType`, which forces MARKETER to
 * INITIATOR unconditionally and rejects REVIEWER as a new value for every
 * other (onboardable) role.
 *
 * REVIEWER is kept as a value only for backward compatibility with records
 * created before this field was enforced (`defaultUserType`'s role-based
 * fallback, staff.schema.ts, used to map MANAGER here) — it is deliberately
 * NOT one of the two assignable values for new staff, and grants neither
 * initiate nor review/approve capabilities under the filter above. An
 * Admin/SuperAdmin must explicitly set a legacy Reviewer-flagged staff
 * member to Initiator or Authorizer (via the staff profile update
 * endpoint) before they can act on anything again.
 */
export enum StaffUserType {
  INITIATOR = 'Initiator',
  REVIEWER = 'Reviewer',
  AUTHORIZER = 'Authorizer',
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

/** Staff.kyc.gender — onboarding-form field, not collected anywhere before this. */
export enum Gender {
  MALE = 'Male',
  FEMALE = 'Female',
}

/** Staff.kyc.idType — which kind of document `idNumber` refers to. */
export enum IdentificationType {
  NIN = 'NIN',
  PASSPORT = 'Passport',
  DRIVERS_LICENSE = 'DriversLicense',
  VOTERS_CARD = 'VotersCard',
}

/** Staff.employmentType — HR-facing, set/edited by an org:manage admin (see UpdateStaffProfileDto), never self-service. */
export enum StaffEmploymentType {
  FULL_TIME = 'FullTime',
  PART_TIME = 'PartTime',
  CONTRACT = 'Contract',
  INTERNSHIP = 'Internship',
  TEMPORARY = 'Temporary',
}
