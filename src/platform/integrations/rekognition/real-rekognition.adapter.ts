import { CompareFacesCommand, RekognitionClient } from '@aws-sdk/client-rekognition';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AwsConfig } from '../../../common/config/configuration';
import { FaceComparisonCallLogService } from './face-comparison-call-log.service';
import {
  FaceComparisonAdapter,
  FaceComparisonCallContext,
  FaceComparisonResult,
} from './interfaces/face-comparison-adapter.interface';

@Injectable()
export class RealRekognitionAdapter implements FaceComparisonAdapter {
  private readonly client: RekognitionClient;
  private readonly bucket: string;
  private readonly matchThreshold: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly callLogService: FaceComparisonCallLogService,
  ) {
    const awsConfig = this.configService.get<AwsConfig>('aws');
    this.client = new RekognitionClient({
      region: awsConfig?.region,
      credentials:
        awsConfig?.accessKeyId && awsConfig.secretAccessKey
          ? { accessKeyId: awsConfig.accessKeyId, secretAccessKey: awsConfig.secretAccessKey }
          : undefined,
    });
    this.bucket = awsConfig?.s3.bucket ?? '';
    this.matchThreshold = awsConfig?.rekognition.faceMatchThreshold ?? 90;
  }

  async compareFaces(
    sourceImageKey: string,
    targetImageBuffer: Buffer,
    context?: FaceComparisonCallContext,
  ): Promise<FaceComparisonResult> {
    try {
      // SourceImage is referenced by S3 key directly (never downloaded through
      // this app); SimilarityThreshold: 0 so AWS always returns the best match
      // it found (if any face was detected at all) rather than silently
      // returning an empty FaceMatches array below our own threshold — we
      // apply `matchThreshold` ourselves so a below-threshold result is still
      // fully visible in the call log, not indistinguishable from "no face
      // detected".
      const response = await this.client.send(
        new CompareFacesCommand({
          SourceImage: { S3Object: { Bucket: this.bucket, Name: sourceImageKey } },
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
      await this.callLogService.record({
        calledBy: context?.calledBy,
        loanId: context?.loanId,
        memberLoanAccountId: context?.memberLoanAccountId,
        customerId: context?.customerId,
        sourceImageKey,
        isMatch: false,
        similarityPercent: 0,
        matchThreshold: this.matchThreshold,
        errorMessage: error instanceof Error ? error.message : 'Unknown Rekognition error',
      });
      throw error;
    }
  }
}
