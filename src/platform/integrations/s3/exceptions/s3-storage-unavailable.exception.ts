import { ServiceUnavailableException } from '@nestjs/common';

/**
 * Any failure talking to S3 — wrong/missing bucket, access denied, network
 * error, etc. Previously these propagated as a bare unhandled exception,
 * which Nest's default filter turns into an opaque "Internal server error"
 * (500, no detail) — this at least surfaces the AWS SDK's own error name/
 * message server-side (never the credentials) so a misconfigured bucket
 * name/region is diagnosable from the response instead of a dead end.
 */
export class S3StorageUnavailableException extends ServiceUnavailableException {
  constructor(step: string, cause?: string) {
    super(`S3 storage is unavailable during ${step}${cause ? `: ${cause}` : ''}`);
  }
}
