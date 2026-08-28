import { StaffRole, StaffUserType } from '../../../common/enums/identity.enums';

export const STAFF_CREATED_EVENT = 'staff.created';

/**
 * Emitted once, right after a Staff document is persisted — from both
 * creation paths (`StaffService.handleWorkflowApproved` for onboarding-
 * approval, `StaffService.createDirect` for SuperAdmin direct creation).
 * `NotificationsModule`'s listener (not IdentityModule) turns this into the
 * actual welcome email — IdentityModule deliberately never imports
 * NotificationsModule directly (NotificationsModule already imports
 * IdentityModule for StaffService/DepartmentsService, so the reverse import
 * would be circular), same decoupling shape as the workflow engine's own
 * events (see workflow-engine.events.ts).
 *
 * `temporaryPassword` is the one and only place this plaintext value ever
 * exists outside of `bcrypt.hash`'s input — an in-memory event payload,
 * never persisted, never logged. See generate-temporary-password.util.ts.
 *
 * `userType` is carried as the value actually persisted on the created
 * Staff document (caller-supplied, or `defaultUserType`'s role-derived
 * fallback — see Staff schema) — the listener no longer derives it itself.
 */
export interface StaffCreatedEvent {
  staffId: string;
  firstName: string;
  lastName: string;
  email: string;
  phoneNumber: string;
  role: StaffRole;
  userType: StaffUserType;
  departmentId: string;
  branchId: string;
  temporaryPassword: string;
}

export const STAFF_DISABLED_EVENT = 'staff.disabled';

/**
 * Emitted right after `StaffService.disable` flips a staff member's status
 * to DISABLED — same cross-module decoupling shape as `STAFF_CREATED_EVENT`
 * (see that event's own doc comment). `disabledByStaffId` is carried as a
 * raw id, not a resolved name — `IdentityEventListenersService` looks up
 * the disabling staff member itself (same "listener resolves, event stays
 * cheap to emit" shape as that listener's own department/branch lookup for
 * `STAFF_CREATED_EVENT`), so `StaffService.disable` doesn't need an extra
 * DB round-trip before returning.
 */
export interface StaffDisabledEvent {
  staffId: string;
  firstName: string;
  email: string;
  phoneNumber: string;
  reason: string;
  disabledByStaffId: string;
  disabledAt: Date;
}

export const STAFF_PASSWORD_CHANGED_EVENT = 'staff.password-changed';

/**
 * Emitted by `StaffService.changePassword` — the *self-service, already
 * logged in* path (current password required, see AuthController's
 * `POST /auth/change-password`). Deliberately separate from
 * `PASSWORD_RESET_COMPLETED_EVENT` (the no-login forgot-password path,
 * see password-reset.events.ts): same "your password changed" intent, but
 * a distinct trigger/template so the email can name the right flow rather
 * than claiming a reset code was used when it wasn't.
 */
export interface StaffPasswordChangedEvent {
  staffId: string;
  firstName: string;
  email: string;
}
