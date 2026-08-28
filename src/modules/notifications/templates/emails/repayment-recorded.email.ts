import { naira } from '../format.util';
import { amountCallout, paragraph, renderEmailLayout } from './email-layout';

export function repaymentRecordedEmail(payload: Record<string, unknown>): string {
  return renderEmailLayout({
    heading: 'Your repayment has been recorded',
    bodyHtml: [
      paragraph('A repayment has been recorded on your loan. Thank you.'),
      amountCallout('Amount', naira(payload.amountKobo)),
    ].join(''),
  });
}
