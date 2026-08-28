export const LOGIN_OTP_ISSUED_EVENT = 'login-otp.issued';

/**
 * Emitted by AuthOtpService right after a challenge is persisted — same
 * cross-module decoupling shape as STAFF_CREATED_EVENT (see staff.events.ts's
 * own comment for why this isn't a direct NotificationsModule call).
 * `code` is the one and only place the plaintext OTP exists outside of the
 * SHA-256 hash stored on the challenge document — in-memory only.
 */
export interface LoginOtpIssuedEvent {
  staffId: string;
  firstName: string;
  email: string;
  phoneNumber: string;
  code: string;
  expiresAt: Date;
}
