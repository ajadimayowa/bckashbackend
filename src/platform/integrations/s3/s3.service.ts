import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AwsConfig } from '../../../common/config/configuration';
import { S3StorageUnavailableException } from './exceptions/s3-storage-unavailable.exception';
import { S3Adapter, S3UploadResult } from './interfaces/s3-adapter.interface';

function describeS3Error(err: unknown): string {
  if (err && typeof err === 'object') {
    const name = 'name' in err ? String((err as { name: unknown }).name) : undefined;
    const message = 'message' in err ? String((err as { message: unknown }).message) : undefined;
    return [name, message].filter(Boolean).join(' — ') || 'unknown error';
  }
  return 'unknown error';
}

/**
 * Required bucket setup (infra task outside this codebase — not provisioned
 * here):
 *
 * - Bucket: private, "Block all public access" ON. No bucket policy grants
 *   public read/write; every access goes through a signed URL issued by this
 *   service using the credentials below.
 * - IAM role/user policy for the credentials this service runs as, scoped to
 *   only what it needs:
 *     {
 *       "Effect": "Allow",
 *       "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
 *       "Resource": "arn:aws:s3:::<bucket-name>/kyc/*"
 *     }
 *   (scope the resource ARN to the `kyc/*` prefix specifically, not the whole
 *   bucket, if this bucket is ever shared with other prefixes later).
 * - Server-side encryption at rest (SSE-S3 or SSE-KMS) enabled on the bucket
 *   — this is *in addition to* the field-level encryption this app applies
 *   to BVN/NIN text fields (see platform/encryption); images aren't
 *   field-level-encrypted by this app, so bucket-level SSE is their only
 *   at-rest protection.
 * - Optional: a lifecycle rule on the `kyc/` prefix if the coop wants
 *   automatic retention limits.
 */
@Injectable()
export class S3Service implements S3Adapter {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly defaultSignedUrlExpiresInSeconds: number;

  constructor(private readonly configService: ConfigService) {
    const awsConfig = this.configService.get<AwsConfig>('aws');
    this.client = new S3Client({
      // `s3.region` is the bucket's own region — it can differ from the
      // top-level `region` used for Rekognition (see AWS_S3_REGION doc in
      // env.validation.ts). `followRegionRedirects` is a safety net on top of
      // that: if this region is ever wrong anyway, the SDK resolves the
      // bucket's real region from S3's PermanentRedirect response and retries
      // instead of failing outright. Note this only covers requests the SDK
      // sends itself (get/put/delete below) — a pre-signed URL is computed
      // up front and does NOT get this fallback, so `getSignedReadUrl` still
      // needs the region to be correct.
      region: awsConfig?.s3.region || awsConfig?.region,
      followRegionRedirects: true,
      credentials:
        awsConfig?.accessKeyId && awsConfig.secretAccessKey
          ? { accessKeyId: awsConfig.accessKeyId, secretAccessKey: awsConfig.secretAccessKey }
          : undefined, // falls back to the default AWS credential provider chain (e.g. an IAM role on Render/EC2)
    });
    this.bucket = awsConfig?.s3.bucket ?? '';
    this.defaultSignedUrlExpiresInSeconds = awsConfig?.s3.signedUrlExpiresInSeconds ?? 300;
  }

  async upload(key: string, buffer: Buffer, contentType: string): Promise<S3UploadResult> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: buffer,
          ContentType: contentType,
          // No ACL set — bucket is private by default; access is exclusively via signed URLs.
        }),
      );
      return { key };
    } catch (err) {
      throw new S3StorageUnavailableException(`upload (bucket "${this.bucket}")`, describeS3Error(err));
    }
  }

  async getSignedReadUrl(key: string, expiresInSeconds?: number): Promise<string> {
    try {
      const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
      return await getSignedUrl(this.client, command, {
        expiresIn: expiresInSeconds ?? this.defaultSignedUrlExpiresInSeconds,
      });
    } catch (err) {
      throw new S3StorageUnavailableException(`signed URL generation (bucket "${this.bucket}")`, describeS3Error(err));
    }
  }

  async getObjectBytes(key: string): Promise<Buffer> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const bytes = await response.Body?.transformToByteArray();
      if (!bytes) {
        throw new Error('empty response body');
      }
      return Buffer.from(bytes);
    } catch (err) {
      throw new S3StorageUnavailableException(`object download (bucket "${this.bucket}")`, describeS3Error(err));
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      throw new S3StorageUnavailableException(`delete (bucket "${this.bucket}")`, describeS3Error(err));
    }
  }
}
