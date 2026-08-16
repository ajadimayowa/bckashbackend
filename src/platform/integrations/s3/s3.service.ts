import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AwsConfig } from '../../../common/config/configuration';
import { S3Adapter, S3UploadResult } from './interfaces/s3-adapter.interface';

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
      region: awsConfig?.region,
      credentials:
        awsConfig?.accessKeyId && awsConfig.secretAccessKey
          ? { accessKeyId: awsConfig.accessKeyId, secretAccessKey: awsConfig.secretAccessKey }
          : undefined, // falls back to the default AWS credential provider chain (e.g. an IAM role on Render/EC2)
    });
    this.bucket = awsConfig?.s3.bucket ?? '';
    this.defaultSignedUrlExpiresInSeconds = awsConfig?.s3.signedUrlExpiresInSeconds ?? 300;
  }

  async upload(key: string, buffer: Buffer, contentType: string): Promise<S3UploadResult> {
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
  }

  async getSignedReadUrl(key: string, expiresInSeconds?: number): Promise<string> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.client, command, {
      expiresIn: expiresInSeconds ?? this.defaultSignedUrlExpiresInSeconds,
    });
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
