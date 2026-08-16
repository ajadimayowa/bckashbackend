import { GoneException } from '@nestjs/common';

/** The consent token's `exp` has passed — either caught client-side before calling the provider, or reported by it. */
export class BvnConsentExpiredException extends GoneException {
  constructor() {
    super('This BVN consent has expired — request a new OTP to continue');
  }
}
