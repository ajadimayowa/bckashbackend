import { GoneException } from '@nestjs/common';

/** The challenge's `expiresAt` has passed — request a fresh consent code before raising the application. */
export class ConsentCodeExpiredException extends GoneException {
  constructor() {
    super('This consent code has expired — request a new one before raising the application');
  }
}
