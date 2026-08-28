import { UnauthorizedException } from '@nestjs/common';

/** The OTP entered doesn't match the hash on the challenge — a wrong-code entry, not a system failure. */
export class OtpInvalidException extends UnauthorizedException {
  constructor() {
    super('The OTP entered does not match — check the code and try again');
  }
}
