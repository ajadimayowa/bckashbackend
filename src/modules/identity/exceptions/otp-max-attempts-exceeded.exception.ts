import { GoneException } from '@nestjs/common';

/**
 * `attemptCount` reached `AuthOtpConfig.maxAttempts` — the challenge is
 * invalidated outright rather than just rate-limited, so a 6-digit code's
 * inherently low entropy can't be ground down by unlimited online guesses.
 * Same remedy as expiry: log in again for a fresh OTP.
 */
export class OtpMaxAttemptsExceededException extends GoneException {
  constructor() {
    super('Too many incorrect attempts — log in again to request a new OTP');
  }
}
