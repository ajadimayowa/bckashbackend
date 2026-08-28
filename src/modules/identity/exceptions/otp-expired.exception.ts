import { GoneException } from '@nestjs/common';

/** The challenge's `expiresAt` has passed — request a fresh login to get a new OTP. */
export class OtpExpiredException extends GoneException {
  constructor() {
    super('This OTP has expired — log in again to request a new one');
  }
}
