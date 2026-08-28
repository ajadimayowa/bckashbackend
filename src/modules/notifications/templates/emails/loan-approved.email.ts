import { paragraph, renderEmailLayout } from './email-layout';

export function loanApprovedEmail(_payload: Record<string, unknown>): string {
  return renderEmailLayout({
    heading: 'Your loan has been approved',
    bodyHtml: [
      paragraph('Good news — your loan application has been approved.'),
      paragraph(
        'Please call your branch to fix a date for your disbursement verification — you\'ll need to visit in person to confirm your identity before the funds can be released.',
      ),
    ].join(''),
  });
}
