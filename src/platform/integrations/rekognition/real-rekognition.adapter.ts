import { CompareFacesCommand, RekognitionClient } from '@aws-sdk/client-rekognition';
import { HttpException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AwsConfig } from '../../../common/config/configuration';
import { S3_ADAPTER, S3Adapter } from '../s3/interfaces/s3-adapter.interface';
import { FaceComparisonCallLogService } from './face-comparison-call-log.service';
import { FaceComparisonInvalidException } from './exceptions/face-comparison-invalid.exception';
import { FaceComparisonProviderUnavailableException } from './exceptions/face-comparison-provider-unavailable.exception';
import {
  FaceComparisonAdapter,
  FaceComparisonCallContext,
  FaceComparisonResult,
} from './interfaces/face-comparison-adapter.interface';

/**
 * Rekognition error names that mean "the input itself is unusable" (typically
 * no detectable face in one of the two images, or a corrupt/oversized image)
 * — a real, expected outcome, not a provider failure. Everything else
 * (throttling, internal errors, access/config problems) is treated as the
 * provider being unavailable. See CompareFacesCommand's documented error shapes.
 */
const INVALID_INPUT_ERROR_NAMES = new Set([
  'InvalidParameterException',
  'InvalidImageFormatException',
  'ImageTooLargeException',
]);

@Injectable()
export class RealRekognitionAdapter implements FaceComparisonAdapter {
  private readonly client: RekognitionClient;
  private readonly matchThreshold: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly callLogService: FaceComparisonCallLogService,
    @Inject(S3_ADAPTER) private readonly s3: S3Adapter,
  ) {
    const awsConfig = this.configService.get<AwsConfig>('aws');
    this.client = new RekognitionClient({
      region: awsConfig?.region,
      credentials:
        awsConfig?.accessKeyId && awsConfig.secretAccessKey
          ? { accessKeyId: awsConfig.accessKeyId, secretAccessKey: awsConfig.secretAccessKey }
          : undefined,
    });
    this.matchThreshold = awsConfig?.rekognition.faceMatchThreshold ?? 90;
  }

  async compareFaces(
    sourceImageKey: string,
    targetImageBuffer: Buffer,
    context?: FaceComparisonCallContext,
  ): Promise<FaceComparisonResult> {
    try {
      // Both images are sent as raw Bytes, not S3Object references. Rekognition
      // requires an S3Object's bucket to live in the same region as the
      // Rekognition endpoint being called; fetching the bytes ourselves and
      // sending them inline removes that coupling entirely, so the KYC bucket
      // and the Rekognition region can differ freely. SimilarityThreshold: 0
      // so AWS always returns the best match it found (if any face was
      // detected at all) rather than silently returning an empty FaceMatches
      // array below our own threshold — we apply `matchThreshold` ourselves so
      // a below-threshold result is still fully visible in the call log, not
      // indistinguishable from "no face detected".
      const sourceImageBuffer = await this.s3.getObjectBytes(sourceImageKey);

      const response = await this.client.send(
        new CompareFacesCommand({
          SourceImage: { Bytes: sourceImageBuffer },
          TargetImage: { Bytes: targetImageBuffer },
          SimilarityThreshold: 0,
        }),
      );

      const bestMatch = response.FaceMatches?.[0];
      const similarityPercent = bestMatch?.Similarity ?? 0;
      const isMatch = similarityPercent >= this.matchThreshold;

      await this.callLogService.record({
        calledBy: context?.calledBy,
        loanId: context?.loanId,
        memberLoanAccountId: context?.memberLoanAccountId,
        customerId: context?.customerId,
        sourceImageKey,
        isMatch,
        similarityPercent,
        matchThreshold: this.matchThreshold,
      });

      return {
        isMatch,
        similarityPercent,
        rawResponse: response as unknown as Record<string, unknown>,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown Rekognition error';
      await this.callLogService.record({
        calledBy: context?.calledBy,
        loanId: context?.loanId,
        memberLoanAccountId: context?.memberLoanAccountId,
        customerId: context?.customerId,
        sourceImageKey,
        isMatch: false,
        similarityPercent: 0,
        matchThreshold: this.matchThreshold,
        errorMessage,
      });

      // Already a typed HTTP exception (e.g. S3StorageUnavailableException
      // from the getObjectBytes call above) — pass it through as-is rather
      // than re-wrapping it as a Rekognition-specific error it isn't.
      if (error instanceof HttpException) {
        throw error;
      }
      if (error instanceof Error && INVALID_INPUT_ERROR_NAMES.has(error.name)) {
        throw new FaceComparisonInvalidException(error.message);
      }
      throw new FaceComparisonProviderUnavailableException(errorMessage);
    }
  }
}
