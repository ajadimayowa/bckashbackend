export const PASSWORD_RESET_REQUESTED_EVENT = 'password-reset.requested';

/**
 * Emitted by `PasswordResetService.requestReset` right after a
 * `PasswordResetChallenge` is persisted — same cross-module decoupling
 * shape as `LOGIN_OTP_ISSUED_EVENT` (see that event's own doc comment for
 * why this isn't a direct `NotificationsModule` call). Only ever emitted
 * for an ACTIVE staff member with a matching email — `requestReset` no-ops
 * silently otherwise, so this event's mere existence doesn't leak account
 * existence. `code` is the one and only place the plaintext reset code
 * exists outside of the SHA-256 hash stored on the challenge — in-memory
 * only.
 */
export interface PasswordResetRequestedEvent {
  staffId: string;
  firstName: string;
  email: string;
  code: string;
  expiresAt: Date;
}

export const PASSWORD_RESET_COMPLETED_EVENT = 'password-reset.completed';

/**
 * Emitted by `PasswordResetService.resetPassword` right after a staff
 * member's password is changed via the no-login-required forgot-password
 * flow — turned into a confirmation email so an unrecognized reset gets
 * noticed. Deliberately separate from the self-service `changePassword`
 * path (`AuthController`/`StaffService.changePassword`), which never emits
 * an event today.
 */
export interface PasswordResetCompletedEvent {
  staffId: string;
  firstName: string;
  email: string;
}
