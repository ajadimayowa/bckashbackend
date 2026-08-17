import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { TermiiConfig } from '../../../common/config/configuration';
import { normalizePhoneNumberForTermii } from './phone-number.util';
import { SmsAdapter, SmsSendResult } from './interfaces/sms-adapter.interface';
import { SmsCallLogService } from './sms-call-log.service';

interface TermiiSendResponse {
  message_id?: string;
  message?: string;
  code?: string;
}

/**
 * Real Termii v3 SMS adapter — `POST {baseUrl}/api/sms/send`. Never throws
 * (see SmsAdapter's own doc comment); every call, success or failure, is
 * logged to SmsCallLog — see that schema's own doc comment.
 *
 * Phone-number normalization happens at this boundary
 * (`normalizePhoneNumberForTermii`) — *** NOT VERIFIED AGAINST A LIVE
 * TERMII CALL, SEE PHASE_11_NOTES.md ***.
 */
@Injectable()
export class RealSmsAdapter implements SmsAdapter {
  private readonly logger = new Logger(RealSmsAdapter.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly smsCallLogService: SmsCallLogService,
  ) {}

  async send(toPhoneNumber: string, message: string): Promise<SmsSendResult> {
    const termii = this.configService.get<TermiiConfig>('termii');
    const normalized = normalizePhoneNumberForTermii(toPhoneNumber);
    const url = `${(termii?.baseUrl ?? '').replace(/\/+$/, '')}/api/sms/send`;

    let status: number | null = null;
    let body: TermiiSendResponse = {};
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: termii?.apiKey,
          to: normalized,
          from: termii?.senderId,
          sms: message,
          type: 'plain',
          channel: 'generic',
        }),
      });
      status = response.status;
      body = (await response.json()) as TermiiSendResponse;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.warn(`SMS send to ${normalized} failed (network): ${errorMessage}`);
      await this.smsCallLogService.record({
        toPhoneNumber: normalized,
        success: false,
        providerStatusCode: null,
        providerMessageId: null,
        errorMessage,
      });
      // Deliberately never throws — the calling queue processor decides
      // whether this is worth a retry.
      return { success: false, error: errorMessage };
    }

    const success = status >= 200 && status < 300 && Boolean(body.message_id);
    await this.smsCallLogService.record({
      toPhoneNumber: normalized,
      success,
      providerStatusCode: status,
      providerMessageId: body.message_id ?? null,
      errorMessage: success ? null : (body.message ?? `HTTP ${status}`),
    });

    if (!success) {
      this.logger.warn(`SMS send to ${normalized} failed: ${body.message ?? `HTTP ${status}`}`);
      return { success: false, error: body.message ?? `HTTP ${status}` };
    }
    return { success: true, messageId: body.message_id };
  }
}
