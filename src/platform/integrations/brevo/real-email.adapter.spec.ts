import { ConfigService } from '@nestjs/config';
import { Transporter } from 'nodemailer';

import { RealEmailAdapter } from './real-email.adapter';

function fakeConfigService(): ConfigService {
  return {
    get: () => ({
      senderEmail: 'no-reply@example.com',
      senderName: 'BCKash MFB',
      mailFrom: undefined,
      smtp: { host: 'smtp-relay.brevo.com', port: 465, secure: true },
    }),
  } as unknown as ConfigService;
}

describe('RealEmailAdapter', () => {
  it('returns { success: true, messageId } on a successful send', async () => {
    const sendMail = jest.fn().mockResolvedValue({ messageId: 'msg-123' });
    const transport = { sendMail, close: jest.fn() } as unknown as Transporter;
    const adapter = new RealEmailAdapter(transport, fakeConfigService());

    const result = await adapter.send('customer@example.com', 'Subject', '<p>Body</p>');

    expect(result).toEqual({ success: true, messageId: 'msg-123' });
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'customer@example.com',
        subject: 'Subject',
        html: '<p>Body</p>',
      }),
    );
  });

  it('returns { success: false, error } — never throws — on a transport failure', async () => {
    const sendMail = jest.fn().mockRejectedValue(new Error('SMTP connection refused'));
    const transport = { sendMail, close: jest.fn() } as unknown as Transporter;
    const adapter = new RealEmailAdapter(transport, fakeConfigService());

    const result = await adapter.send('customer@example.com', 'Subject', '<p>Body</p>');

    expect(result).toEqual({ success: false, error: 'SMTP connection refused' });
  });

  it('uses mailFrom as a full-string override when set', async () => {
    const sendMail = jest.fn().mockResolvedValue({ messageId: 'msg-1' });
    const transport = { sendMail, close: jest.fn() } as unknown as Transporter;
    const configService = {
      get: () => ({
        senderEmail: 'no-reply@example.com',
        senderName: 'BCKash MFB',
        mailFrom: 'BCKash MFB <no-reply@bckashmfb.com>',
        smtp: { host: 'smtp-relay.brevo.com', port: 465, secure: true },
      }),
    } as unknown as ConfigService;
    const adapter = new RealEmailAdapter(transport, configService);

    await adapter.send('customer@example.com', 'Subject', '<p>Body</p>');

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'BCKash MFB <no-reply@bckashmfb.com>' }),
    );
  });
});
