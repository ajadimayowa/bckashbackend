import { naira } from '../format.util';
import { amountCallout, paragraph, renderEmailLayout } from './email-layout';

export function loanRaisedEmail(payload: Record<string, unknown>): string {
  const heading = 'Your loan application has been raised';
  return renderEmailLayout({
    heading,
    bodyHtml: [
      paragraph('Your loan application has been raised as part of a group loan.'),
      amountCallout('Your share', naira(payload.memberAmountKobo)),
      paragraph("We'll notify you again as verification and disbursement proceed."),
    ].join(''),
  });
}
