import { naira, str } from '../format.util';
import { amountCallout, escapeHtml, paragraph, renderEmailLayout } from './email-layout';

export function penaltyChargedEmail(payload: Record<string, unknown>): string {
  const context = str(payload.context, '');
  return renderEmailLayout({
    heading: 'A penalty has been applied to your loan',
    bodyHtml: [
      amountCallout('Penalty amount', naira(payload.amountKobo)),
      context ? paragraph(escapeHtml(context)) : '',
    ].join(''),
  });
}
