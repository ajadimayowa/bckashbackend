import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';

import type { TermiiConfig } from '../../../common/config/configuration';
import { SMS_ADAPTER } from './interfaces/sms-adapter.interface';
import { MockSmsAdapter } from './mock-sms.adapter';
import { RealSmsAdapter } from './real-sms.adapter';
import { SmsCallLog, SmsCallLogSchema } from './schemas/sms-call-log.schema';
import { SmsCallLogService } from './sms-call-log.service';

/** Same mock/real provider-selection pattern as BrevoModule/BvnIntegrationModule. */
@Module({
  imports: [MongooseModule.forFeature([{ name: SmsCallLog.name, schema: SmsCallLogSchema }])],
  providers: [
    SmsCallLogService,
    RealSmsAdapter,
    MockSmsAdapter,
    {
      provide: SMS_ADAPTER,
      inject: [ConfigService, RealSmsAdapter, MockSmsAdapter],
      useFactory: (config: ConfigService, real: RealSmsAdapter, mock: MockSmsAdapter) => {
        const termiiConfig = config.get<TermiiConfig>('termii');
        return termiiConfig?.useMock ? mock : real;
      },
    },
  ],
  exports: [SMS_ADAPTER, SmsCallLogService],
})
export class TermiiModule {}
