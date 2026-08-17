import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import { normalizePhoneNumberForTermii } from './phone-number.util';
import { SmsAdapter, SmsSendResult } from './interfaces/sms-adapter.interface';
import { SmsCallLogService } from './sms-call-log.service';

/**
 * Deterministic, in-memory stand-in — no live calls, selected via config
 * (see termii.module.ts). Still writes real SmsCallLog entries, same
 * reasoning as MockBvnVerificationAdapter — so the call-logging requirement
 * is exercised against this adapter too.
 */
@Injectable()
export class MockSmsAdapter implements SmsAdapter {
  private readonly logger = new Logger(MockSmsAdapter.name);

  constructor(private readonly smsCallLogService: SmsCallLogService) {}

  async send(toPhoneNumber: string, message: string): Promise<SmsSendResult> {
    const normalized = normalizePhoneNumberForTermii(toPhoneNumber);
    this.logger.log(`[MOCK] SMS to ${normalized}: "${message}"`);
    const messageId = `mock-${randomUUID()}`;
    await this.smsCallLogService.record({
      toPhoneNumber: normalized,
      success: true,
      providerStatusCode: 200,
      providerMessageId: messageId,
      errorMessage: null,
    });
    return { success: true, messageId };
  }
}
