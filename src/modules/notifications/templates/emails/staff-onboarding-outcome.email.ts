import { str } from '../format.util';
import { paragraph, renderEmailLayout } from './email-layout';

export function staffOnboardingOutcomeEmail(payload: Record<string, unknown>): string {
  const outcome = str(payload.outcome, 'decided');
  return renderEmailLayout({
    heading: `Your staff onboarding has been ${outcome}`,
    bodyHtml: paragraph(`Your staff onboarding request has been <strong>${outcome}</strong>.`),
  });
}
