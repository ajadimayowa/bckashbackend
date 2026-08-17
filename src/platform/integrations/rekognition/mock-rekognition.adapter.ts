import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AwsConfig } from '../../../common/config/configuration';
import { FaceComparisonCallLogService } from './face-comparison-call-log.service';
import {
  FaceComparisonAdapter,
  FaceComparisonCallContext,
  FaceComparisonResult,
} from './interfaces/face-comparison-adapter.interface';

/**
 * Deterministic, in-memory stand-in — no live AWS calls. Selected via config
 * (see rekognition.module.ts) when AWS credentials aren't set or
 * AWS_REKOGNITION_USE_MOCK=true, same pattern as Mock{Bvn,S3}. A caller can
 * force a "failed" comparison deterministically by including this exact
 * marker string anywhere in `targetImageBuffer` — used by tests to exercise
 * the ESCALATED path without depending on real image bytes.
 */
export const MOCK_FACE_COMPARISON_FAIL_MARKER = 'MOCK_FACE_COMPARISON_FAIL';

@Injectable()
export class MockRekognitionAdapter implements FaceComparisonAdapter {
  private readonly matchThreshold: number;

  constructor(
    configService: ConfigService,
    private readonly callLogService: FaceComparisonCallLogService,
  ) {
    const awsConfig = configService.get<AwsConfig>('aws');
    this.matchThreshold = awsConfig?.rekognition.faceMatchThreshold ?? 90;
  }

  async compareFaces(
    sourceImageKey: string,
    targetImageBuffer: Buffer,
    context?: FaceComparisonCallContext,
  ): Promise<FaceComparisonResult> {
    const shouldFail = targetImageBuffer.includes(MOCK_FACE_COMPARISON_FAIL_MARKER);
    const similarityPercent = shouldFail ? 10 : 99;
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
      rawResponse: { mock: true, sourceImageKey },
    };
  }
}
