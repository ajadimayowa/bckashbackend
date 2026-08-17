import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { Transporter } from 'nodemailer';

import type { BrevoConfig } from '../../../common/config/configuration';
import { EmailAdapter, EmailSendResult } from './interfaces/email-adapter.interface';

/**
 * Real Brevo SMTP relay adapter, via Nodemailer — per the brief, built once
 * (connection pooling), not per-send. Injectable token for the transport
 * itself (`BREVO_SMTP_TRANSPORT`) so it can be swapped out in tests without
 * touching this class's logic — see real-email.adapter.spec.ts.
 */
export const BREVO_SMTP_TRANSPORT = Symbol('BREVO_SMTP_TRANSPORT');

export function createBrevoSmtpTransport(config: ConfigService): Transporter {
  const brevo = config.get<BrevoConfig>('brevo');
  return nodemailer.createTransport({
    pool: true,
    host: brevo?.smtp.host,
    port: brevo?.smtp.port,
    secure: brevo?.smtp.secure,
    auth:
      brevo?.smtp.login && brevo.smtp.key
        ? { user: brevo.smtp.login, pass: brevo.smtp.key }
        : undefined,
  });
}

@Injectable()
export class RealEmailAdapter implements EmailAdapter, OnModuleDestroy {
  private readonly logger = new Logger(RealEmailAdapter.name);

  constructor(
    @Inject(BREVO_SMTP_TRANSPORT) private readonly transport: Transporter,
    private readonly configService: ConfigService,
  ) {}

  async send(
    to: string,
    subject: string,
    htmlBody: string,
    textBody?: string,
  ): Promise<EmailSendResult> {
    const brevo = this.configService.get<BrevoConfig>('brevo');
    const from = brevo?.mailFrom ?? `"${brevo?.senderName ?? ''}" <${brevo?.senderEmail ?? ''}>`;

    try {
      // nodemailer types `sendMail`'s resolved value as `SentMessageInfo`
      // (effectively `any` — different transports return different shapes),
      // so it's narrowed explicitly here rather than trusted as-is.
      const info = (await this.transport.sendMail({
        from,
        to,
        subject,
        html: htmlBody,
        text: textBody,
      })) as { messageId?: string };
      return { success: true, messageId: info.messageId };
    } catch (error) {
      // Deliberately never throws — see EmailAdapter's own doc comment. The
      // calling queue processor decides whether this is worth a retry.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Email send to ${to} failed: ${message}`);
      return { success: false, error: message };
    }
  }

  onModuleDestroy(): void {
    this.transport.close();
  }
}
