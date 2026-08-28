import { GoneException } from '@nestjs/common';

/**
 * `attemptCount` reached the configured max — the challenge is invalidated
 * outright rather than just rate-limited, same reasoning as identity's
 * OtpMaxAttemptsExceededException. Request a fresh code to try again.
 */
export class ConsentCodeMaxAttemptsExceededException extends GoneException {
  constructor() {
    super('Too many incorrect attempts — request a new consent code to try again');
  }
}
