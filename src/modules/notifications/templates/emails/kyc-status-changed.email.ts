import { str } from '../format.util';
import { paragraph, renderEmailLayout } from './email-layout';

export function kycStatusChangedEmail(payload: Record<string, unknown>): string {
  const status = str(payload.status, 'updated');
  return renderEmailLayout({
    heading: 'Your KYC status has been updated',
    bodyHtml: paragraph(`Your KYC verification status is now: <strong>${status}</strong>.`),
  });
}
