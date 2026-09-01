import { ServiceUnavailableException } from '@nestjs/common';

/** Timeout, connection failure, throttling, or any other Rekognition-side failure that isn't the input's fault. */
export class FaceComparisonProviderUnavailableException extends ServiceUnavailableException {
  constructor(cause?: string) {
    super(`Face comparison provider is unavailable${cause ? `: ${cause}` : ''}`);
  }
}
