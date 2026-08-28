import { UnauthorizedException } from '@nestjs/common';

/** The consent code entered doesn't match the hash on the challenge — a wrong-code entry, not a system failure. */
export class ConsentCodeInvalidException extends UnauthorizedException {
  constructor() {
    super('The consent code entered does not match — check with the customer and try again');
  }
}
