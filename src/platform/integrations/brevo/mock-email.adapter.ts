import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { EmailAdapter, EmailSendResult } from './interfaces/email-adapter.interface';

/** Same "mock adapter, selected via config, no live network calls" pattern as every other external adapter in this system (BVN, S3, Rekognition). */
@Injectable()
export class MockEmailAdapter implements EmailAdapter {
  private readonly logger = new Logger(MockEmailAdapter.name);

  send(to: string, subject: string): Promise<EmailSendResult> {
    this.logger.log(`[MOCK] Email to ${to}: "${subject}"`);
    return Promise.resolve({ success: true, messageId: `mock-${randomUUID()}` });
  }
}
