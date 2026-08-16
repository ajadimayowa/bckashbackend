import { ServiceUnavailableException } from '@nestjs/common';

/** Timeout, connection failure, non-2xx provider error, or a malformed response body. */
export class BvnProviderUnavailableException extends ServiceUnavailableException {
  constructor(step: string, cause?: string) {
    super(`BVN provider is unavailable during ${step}${cause ? `: ${cause}` : ''}`);
  }
}
