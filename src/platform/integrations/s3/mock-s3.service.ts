import { Injectable } from '@nestjs/common';

import { S3Adapter, S3UploadResult } from './interfaces/s3-adapter.interface';

/**
 * In-memory stand-in for local dev / tests — no AWS credentials required.
 * Selected via config (see s3.module.ts), same pattern as the BVN mock adapter.
 */
@Injectable()
export class MockS3Service implements S3Adapter {
  private readonly store = new Map<string, { buffer: Buffer; contentType: string }>();

  upload(key: string, buffer: Buffer, contentType: string): Promise<S3UploadResult> {
    this.store.set(key, { buffer, contentType });
    return Promise.resolve({ key, url: `mock://s3/${key}` });
  }

  getSignedReadUrl(key: string, expiresInSeconds = 300): Promise<string> {
    return Promise.resolve(`mock://s3/${key}?expiresIn=${expiresInSeconds}`);
  }

  delete(key: string): Promise<void> {
    this.store.delete(key);
    return Promise.resolve();
  }

  /** Test-only inspection hook. */
  has(key: string): boolean {
    return this.store.has(key);
  }
}
