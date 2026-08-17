import { DynamicModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

/**
 * Minimal global ConfigModule for tests that need `ConfigService.get('aws')`
 * — same reasoning as test-bvn-config.module.ts. Defaults to the mock
 * Rekognition adapter (`useMock: true`) so tests exercise MockRekognitionAdapter
 * without needing real AWS credentials; `faceMatchThreshold` matches the
 * app-wide default (90) unless a test needs a different boundary.
 */
export function testAwsConfigModule(
  overrides: Partial<{ faceMatchThreshold: number; bucket: string }> = {},
): Promise<DynamicModule> {
  return ConfigModule.forRoot({
    isGlobal: true,
    ignoreEnvFile: true,
    load: [
      () => ({
        aws: {
          region: 'us-east-1',
          s3: {
            bucket: overrides.bucket ?? 'test-bucket',
            signedUrlExpiresInSeconds: 300,
            useMock: true,
          },
          rekognition: {
            faceMatchThreshold: overrides.faceMatchThreshold ?? 90,
            useMock: true,
          },
        },
      }),
    ],
  });
}
