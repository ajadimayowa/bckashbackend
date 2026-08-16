import { UnauthorizedException } from '@nestjs/common';

/** The OTP did not match the hash embedded in the consent token — a wrong-code entry, not a system failure. */
export class BvnOtpInvalidException extends UnauthorizedException {
  constructor() {
    super('The OTP entered does not match — check the code and try again');
  }
}
