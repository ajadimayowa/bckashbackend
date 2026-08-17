import { NotificationTrigger } from '../../../common/enums/notification.enums';
import { NotificationTemplate } from './notification-template.interface';

/** Local to this file only — no other module currently needs a kobo->naira display formatter. */
function naira(amountKobo: unknown): string {
  const amount = typeof amountKobo === 'number' ? amountKobo : 0;
  return `₦${(amount / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Narrows an `unknown` payload field to a display string, falling back
 * rather than risking `[object Object]` (payloads are untyped
 * `Record<string, unknown>` here — see notification-template.interface.ts).
 */
function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * One entry per `NotificationTrigger` value — registered at module init by
 * `NotificationTemplateRegistry` (which also asserts nothing's missing; see
 * that class's own doc comment). Simple string interpolation, no templating
 * engine, per the brief. SMS bodies are kept short deliberately — most SMS
 * gateways (Termii included) charge per 160-character segment.
 *
 * Every trigger from the brief's own `NotificationType` list is covered,
 * cross-checked against every phase's notes for "notify"/"notification"
 * mentions — see PHASE_11_NOTES.md for the full reconciliation (which
 * triggers have a real call site today vs. are forward-looking hooks for a
 * later phase). `FUNDING_REMINDER` is additionally covered even though it's
 * outside the brief's own list — it's a pre-existing Phase 1/2 placeholder
 * value on this same enum, costs nothing to template, and is documented as
 * such rather than silently dropped.
 */
export const NOTIFICATION_TEMPLATES: Record<NotificationTrigger, NotificationTemplate> = {
  [NotificationTrigger.LOAN_RAISED]: {
    type: NotificationTrigger.LOAN_RAISED,
    emailSubject: () => 'Your loan application has been raised',
    emailBody: (p) =>
      `Your loan application has been raised. Your share of the loan is ${naira(p.memberAmountKobo)}, as part of a group loan totalling ${naira(p.groupCumulativeAmountKobo)}. We will notify you as verification and disbursement proceed.`,
    smsBody: (p) =>
      `Loan raised: your share ${naira(p.memberAmountKobo)} (group total ${naira(p.groupCumulativeAmountKobo)}). We'll update you soon.`,
  },
  [NotificationTrigger.KYC_STATUS_CHANGED]: {
    type: NotificationTrigger.KYC_STATUS_CHANGED,
    emailSubject: () => 'Your KYC status has been updated',
    emailBody: (p) => `Your KYC verification status is now: ${str(p.status, 'updated')}.`,
    smsBody: (p) => `Your KYC status is now: ${str(p.status, 'updated')}.`,
  },
  [NotificationTrigger.WORKFLOW_OUTCOME]: {
    type: NotificationTrigger.WORKFLOW_OUTCOME,
    emailSubject: (p) =>
      `Your ${str(p.entityType, 'request')} request has been ${str(p.outcome, 'decided')}`,
    emailBody: (p) =>
      `Your ${str(p.entityType, 'request')} request has been ${str(p.outcome, 'decided')}.${p.comment ? ` Comment: ${str(p.comment, '')}` : ''}`,
    smsBody: (p) =>
      `Your ${str(p.entityType, 'request')} request was ${str(p.outcome, 'decided')}.`,
  },
  [NotificationTrigger.VERIFICATION_ESCALATED]: {
    type: NotificationTrigger.VERIFICATION_ESCALATED,
    emailSubject: () => 'Loan verification requires attention',
    emailBody: (p) =>
      `Verification for loan ${str(p.loanId, '')} has been escalated for review. Reason: ${str(p.reason, 'unspecified')}.`,
    smsBody: (p) =>
      `Loan ${str(p.loanId, '')} verification escalated: ${str(p.reason, 'see details')}.`,
  },
  [NotificationTrigger.DISBURSEMENT_COMPLETED]: {
    type: NotificationTrigger.DISBURSEMENT_COMPLETED,
    emailSubject: () => 'Your loan has been disbursed',
    emailBody: (p) =>
      `Your loan of ${naira(p.amountKobo)} has been disbursed via ${str(p.channel, 'your selected channel')}.`,
    smsBody: (p) => `Disbursed: ${naira(p.amountKobo)} via ${str(p.channel, 'your channel')}.`,
  },
  [NotificationTrigger.REPAYMENT_RECORDED]: {
    type: NotificationTrigger.REPAYMENT_RECORDED,
    emailSubject: () => 'Your repayment has been recorded',
    emailBody: (p) => `A repayment of ${naira(p.amountKobo)} has been recorded on your loan.`,
    smsBody: (p) => `Repayment of ${naira(p.amountKobo)} recorded. Thank you.`,
  },
  [NotificationTrigger.REPAYMENT_DISPUTED]: {
    type: NotificationTrigger.REPAYMENT_DISPUTED,
    emailSubject: () => 'A repayment dispute has been raised',
    emailBody: (p) =>
      `A dispute has been raised on repayment record ${str(p.repaymentRecordId, '')}. Reason: ${str(p.reason, 'unspecified')}. Please review.`,
    smsBody: (p) => `Repayment dispute raised: ${str(p.reason, 'see details')}.`,
  },
  [NotificationTrigger.PENALTY_CHARGED]: {
    type: NotificationTrigger.PENALTY_CHARGED,
    emailSubject: () => 'A penalty has been applied to your loan',
    emailBody: (p) => `A penalty of ${naira(p.amountKobo)} has been applied. ${str(p.context, '')}`,
    smsBody: (p) => `Penalty applied: ${naira(p.amountKobo)}. ${str(p.context, '')}`,
  },
  [NotificationTrigger.ACCOUNT_DISABLED]: {
    type: NotificationTrigger.ACCOUNT_DISABLED,
    emailSubject: () => 'Your account has been disabled',
    emailBody: (p) =>
      `Your staff account has been disabled. Reason: ${str(p.reason, 'unspecified')}. Contact your Admin for details.`,
    smsBody: (p) => `Your account was disabled: ${str(p.reason, 'contact Admin')}.`,
  },
  [NotificationTrigger.FUNDING_REMINDER]: {
    type: NotificationTrigger.FUNDING_REMINDER,
    emailSubject: () => 'Branch funding reminder',
    emailBody: (p) => `This is a reminder that branch funding is due. ${str(p.details, '')}`,
    smsBody: (p) => `Reminder: branch funding due. ${str(p.details, '')}`,
  },
  [NotificationTrigger.STAFF_ONBOARDING_OUTCOME]: {
    type: NotificationTrigger.STAFF_ONBOARDING_OUTCOME,
    emailSubject: (p) => `Your staff onboarding has been ${str(p.outcome, 'decided')}`,
    emailBody: (p) => `Your staff onboarding request has been ${str(p.outcome, 'decided')}.`,
    smsBody: (p) => `Onboarding ${str(p.outcome, 'decided')}.`,
  },
};
