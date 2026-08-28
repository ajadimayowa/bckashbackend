import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';

import type { BvnConfig } from '../../../common/config/configuration';
import { BvnCallLogService } from './bvn-call-log.service';
import { BvnHttpClient } from './bvn-http-client.service';
import { BvnProviderAuthService } from './bvn-provider-auth.service';
import { BVN_VERIFICATION_ADAPTER } from './interfaces/bvn-verification-adapter.interface';
import { MockBvnVerificationAdapter } from './mock-bvn-verification.adapter';
import { RealBvnVerificationAdapter } from './real-bvn-verification.adapter';
import { BvnCallLog, BvnCallLogSchema } from './schemas/bvn-call-log.schema';

@Module({
  imports: [MongooseModule.forFeature([{ name: BvnCallLog.name, schema: BvnCallLogSchema }])],
  providers: [
    BvnCallLogService,
    BvnProviderAuthService,
    BvnHttpClient,
    RealBvnVerificationAdapter,
    MockBvnVerificationAdapter,
    {
      provide: BVN_VERIFICATION_ADAPTER,
      inject: [ConfigService, RealBvnVerificationAdapter, MockBvnVerificationAdapter],
      useFactory: (
        config: ConfigService,
        real: RealBvnVerificationAdapter,
        mock: MockBvnVerificationAdapter,
      ) => {
        const bvnConfig = config.get<BvnConfig>('bvn');
        return bvnConfig?.useMock ? mock : real;
      },
    },
  ],
  exports: [BVN_VERIFICATION_ADAPTER, BvnCallLogService, BvnProviderAuthService],
})
export class BvnIntegrationModule {}
