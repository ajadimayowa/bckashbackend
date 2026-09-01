import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';

import type { AwsConfig } from '../../../common/config/configuration';
import { S3IntegrationModule } from '../s3/s3.module';
import { FaceComparisonCallLogService } from './face-comparison-call-log.service';
import { FACE_COMPARISON_ADAPTER } from './interfaces/face-comparison-adapter.interface';
import { MockRekognitionAdapter } from './mock-rekognition.adapter';
import { RealRekognitionAdapter } from './real-rekognition.adapter';
import {
  FaceComparisonCallLog,
  FaceComparisonCallLogSchema,
} from './schemas/face-comparison-call-log.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: FaceComparisonCallLog.name, schema: FaceComparisonCallLogSchema },
    ]),
    S3IntegrationModule,
  ],
  providers: [
    FaceComparisonCallLogService,
    RealRekognitionAdapter,
    MockRekognitionAdapter,
    {
      provide: FACE_COMPARISON_ADAPTER,
      inject: [ConfigService, RealRekognitionAdapter, MockRekognitionAdapter],
      useFactory: (
        config: ConfigService,
        real: RealRekognitionAdapter,
        mock: MockRekognitionAdapter,
      ) => {
        const awsConfig = config.get<AwsConfig>('aws');
        return awsConfig?.rekognition.useMock ? mock : real;
      },
    },
  ],
  exports: [FACE_COMPARISON_ADAPTER, FaceComparisonCallLogService],
})
export class RekognitionIntegrationModule {}
