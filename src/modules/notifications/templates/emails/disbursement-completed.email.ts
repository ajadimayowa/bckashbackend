import { naira, str } from '../format.util';
import { amountCallout, escapeHtml, paragraph, renderEmailLayout } from './email-layout';

export function disbursementCompletedEmail(payload: Record<string, unknown>): string {
  const channel = str(payload.channel, 'your selected channel');
  return renderEmailLayout({
    heading: 'Your loan has been disbursed',
    bodyHtml: [
      paragraph(`Your loan has been disbursed via <strong>${escapeHtml(channel)}</strong>.`),
      amountCallout('Amount disbursed', naira(payload.amountKobo)),
    ].join(''),
  });
}
