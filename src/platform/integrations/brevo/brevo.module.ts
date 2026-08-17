import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { BrevoConfig } from '../../../common/config/configuration';
import { EMAIL_ADAPTER } from './interfaces/email-adapter.interface';
import { MockEmailAdapter } from './mock-email.adapter';
import {
  BREVO_SMTP_TRANSPORT,
  RealEmailAdapter,
  createBrevoSmtpTransport,
} from './real-email.adapter';

/**
 * Same mock/real provider-selection pattern as `BvnIntegrationModule`
 * (`bvn.module.ts`) — `EMAIL_ADAPTER` resolves to the real SMTP adapter or
 * the no-op mock depending on `BrevoConfig.useMock`. The transport itself
 * (Nodemailer's connection pool) is a global singleton, built once here —
 * `nodemailer.createTransport` doesn't open a connection until the first
 * send, so constructing it even when the mock is selected is harmless.
 */
@Module({
  providers: [
    MockEmailAdapter,
    RealEmailAdapter,
    {
      provide: BREVO_SMTP_TRANSPORT,
      inject: [ConfigService],
      useFactory: createBrevoSmtpTransport,
    },
    {
      provide: EMAIL_ADAPTER,
      inject: [ConfigService, RealEmailAdapter, MockEmailAdapter],
      useFactory: (config: ConfigService, real: RealEmailAdapter, mock: MockEmailAdapter) => {
        const brevoConfig = config.get<BrevoConfig>('brevo');
        return brevoConfig?.useMock ? mock : real;
      },
    },
  ],
  exports: [EMAIL_ADAPTER],
})
export class BrevoModule {}
