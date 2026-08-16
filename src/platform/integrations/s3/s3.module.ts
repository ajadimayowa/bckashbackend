import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AwsConfig } from '../../../common/config/configuration';
import { S3_ADAPTER } from './interfaces/s3-adapter.interface';
import { MockS3Service } from './mock-s3.service';
import { S3Service } from './s3.service';

@Module({
  providers: [
    S3Service,
    MockS3Service,
    {
      provide: S3_ADAPTER,
      inject: [ConfigService, S3Service, MockS3Service],
      useFactory: (config: ConfigService, real: S3Service, mock: MockS3Service) => {
        const awsConfig = config.get<AwsConfig>('aws');
        return awsConfig?.s3.useMock ? mock : real;
      },
    },
  ],
  exports: [S3_ADAPTER],
})
export class S3IntegrationModule {}
