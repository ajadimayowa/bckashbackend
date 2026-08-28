import { NotificationTrigger } from '../../../common/enums/notification.enums';
import { EMAIL_TEMPLATES } from './emails';
import { naira, str } from './format.util';
import { NotificationTemplate } from './notification-template.interface';

/**
 * One entry per `NotificationTrigger` value — registered at module init by
 * `NotificationTemplateRegistry` (which also asserts nothing's missing; see
 * that class's own doc comment). `emailBody` delegates to the branded HTML
 * templates in `./emails/` (BCKash Cooperative header/footer, one file per
 * trigger); `emailSubject`/`smsBody` stay simple string interpolation here
 * — no templating engine, per the brief, and SMS bodies are kept short
 * deliberately (most SMS gateways, Termii included, charge per 160-
 * character segment).
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
    emailBody: EMAIL_TEMPLATES[NotificationTrigger.LOAN_RAISED],
    smsBody: (p) => `Loan raised: your share ${naira(p.memberAmountKobo)}. We'll update you soon.`,
  },
  [NotificationTrigger.LOAN_APPROVED]: {
    type: NotificationTrigger.LOAN_APPROVED,
    emailSubject: () => 'Your loan has been approved',
    emailBody: EMAIL_TEMPLATES[NotificationTrigger.LOAN_APPROVED],
    smsBody: () =>
      "Loan approved! Call your branch to fix a date for disbursement verification.",
  },
  [NotificationTrigger.KYC_STATUS_CHANGED]: {
    type: NotificationTrigger.KYC_STATUS_CHANGED,
    emailSubject: () => 'Your KYC status has been updated',
    emailBody: EMAIL_TEMPLATES[NotificationTrigger.KYC_STATUS_CHANGED],
    smsBody: (p) => `Your KYC status is now: ${str(p.status, 'updated')}.`,
  },
  [NotificationTrigger.WORKFLOW_OUTCOME]: {
    type: NotificationTrigger.WORKFLOW_OUTCOME,
    emailSubject: (p) =>
      `Your ${str(p.entityType, 'request')} request has been ${str(p.outcome, 'decided')}`,
    emailBody: EMAIL_TEMPLATES[NotificationTrigger.WORKFLOW_OUTCOME],
    smsBody: (p) =>
      `Your ${str(p.entityType, 'request')} request was ${str(p.outcome, 'decided')}.`,
  },
  [NotificationTrigger.VERIFICATION_ESCALATED]: {
    type: NotificationTrigger.VERIFICATION_ESCALATED,
    emailSubject: () => 'Loan verification requires attention',
    emailBody: EMAIL_TEMPLATES[NotificationTrigger.VERIFICATION_ESCALATED],
    smsBody: (p) =>
      `Loan ${str(p.loanId, '')} verification escalated: ${str(p.reason, 'see details')}.`,
  },
  [NotificationTrigger.DISBURSEMENT_COMPLETED]: {
    type: NotificationTrigger.DISBURSEMENT_COMPLETED,
    emailSubject: () => 'Your loan has been disbursed',
    emailBody: EMAIL_TEMPLATES[NotificationTrigger.DISBURSEMENT_COMPLETED],
    smsBody: (p) => `Disbursed: ${naira(p.amountKobo)} via ${str(p.channel, 'your channel')}.`,
  },
  [NotificationTrigger.REPAYMENT_RECORDED]: {
    type: NotificationTrigger.REPAYMENT_RECORDED,
    emailSubject: () => 'Your repayment has been recorded',
    emailBody: EMAIL_TEMPLATES[NotificationTrigger.REPAYMENT_RECORDED],
    smsBody: (p) => `Repayment of ${naira(p.amountKobo)} recorded. Thank you.`,
  },
  [NotificationTrigger.REPAYMENT_DISPUTED]: {
    type: NotificationTrigger.REPAYMENT_DISPUTED,
    emailSubject: () => 'A repayment dispute has been raised',
    emailBody: EMAIL_TEMPLATES[NotificationTrigger.REPAYMENT_DISPUTED],
    smsBody: (p) => `Repayment dispute raised: ${str(p.reason, 'see details')}.`,
  },
  [NotificationTrigger.PENALTY_CHARGED]: {
    type: NotificationTrigger.PENALTY_CHARGED,
    emailSubject: () => 'A penalty has been applied to your loan',
    emailBody: EMAIL_TEMPLATES[NotificationTrigger.PENALTY_CHARGED],
    smsBody: (p) => `Penalty applied: ${naira(p.amountKobo)}. ${str(p.context, '')}`,
  },
  [NotificationTrigger.ACCOUNT_DISABLED]: {
    type: NotificationTrigger.ACCOUNT_DISABLED,
    emailSubject: () => 'Your account has been disabled',
    emailBody: EMAIL_TEMPLATES[NotificationTrigger.ACCOUNT_DISABLED],
    smsBody: (p) =>
      `Your account was disabled by ${str(p.disabledByName, 'an administrator')}: ${str(p.reason, 'contact Admin')}.`,
  },
  [NotificationTrigger.FUNDING_REMINDER]: {
    type: NotificationTrigger.FUNDING_REMINDER,
    emailSubject: () => 'Branch funding reminder',
    emailBody: EMAIL_TEMPLATES[NotificationTrigger.FUNDING_REMINDER],
    smsBody: (p) => `Reminder: branch funding due. ${str(p.details, '')}`,
  },
  [NotificationTrigger.STAFF_ONBOARDING_OUTCOME]: {
    type: NotificationTrigger.STAFF_ONBOARDING_OUTCOME,
    emailSubject: (p) => `Your staff onboarding has been ${str(p.outcome, 'decided')}`,
    emailBody: EMAIL_TEMPLATES[NotificationTrigger.STAFF_ONBOARDING_OUTCOME],
    smsBody: (p) => `Onboarding ${str(p.outcome, 'decided')}.`,
  },
  [NotificationTrigger.STAFF_WELCOME]: {
    type: NotificationTrigger.STAFF_WELCOME,
    emailSubject: () => 'Welcome to BCKash Cooperative — your login details',
    emailBody: EMAIL_TEMPLATES[NotificationTrigger.STAFF_WELCOME],
    smsBody: (p) =>
      `Welcome to BCKash Cooperative. Temp password: ${str(p.temporaryPassword, '')}. Change it on first login.`,
  },
  [NotificationTrigger.LOGIN_OTP]: {
    type: NotificationTrigger.LOGIN_OTP,
    emailSubject: () => 'Your BCKash Cooperative login code',
    emailBody: EMAIL_TEMPLATES[NotificationTrigger.LOGIN_OTP],
    smsBody: (p) => `Your BCKash Cooperative login code is ${str(p.code, '')}.`,
  },
  // The forgot-password flow itself only ever emails these (see
  // PasswordResetService, IdentityEventListenersService — both dispatch
  // with `phone: null`, so the SMS leg is never actually attempted for
  // them today), but `smsBody` is still defined here for the same reason
  // every other trigger's is: NotificationAdminController's manual resend
  // can target any channel, and NotificationTemplateRegistry asserts every
  // trigger renders all three.
  [NotificationTrigger.PASSWORD_RESET_OTP]: {
    type: NotificationTrigger.PASSWORD_RESET_OTP,
    emailSubject: () => 'Your password reset code',
    emailBody: EMAIL_TEMPLATES[NotificationTrigger.PASSWORD_RESET_OTP],
    smsBody: (p) => `Your BCKash Cooperative password reset code is ${str(p.code, '')}.`,
  },
  [NotificationTrigger.PASSWORD_RESET_CONFIRMATION]: {
    type: NotificationTrigger.PASSWORD_RESET_CONFIRMATION,
    emailSubject: () => 'Your password has been changed',
    emailBody: EMAIL_TEMPLATES[NotificationTrigger.PASSWORD_RESET_CONFIRMATION],
    smsBody: () => 'Your BCKash Cooperative password was just reset. Not you? Contact your Admin.',
  },
  // Self-service, already-logged-in change (POST /auth/change-password) —
  // see StaffService.changePassword, STAFF_PASSWORD_CHANGED_EVENT. No
  // phone recipient today (same email-only posture as PASSWORD_RESET_OTP/
  // _CONFIRMATION above), smsBody still defined for the same reasons those
  // two are.
  [NotificationTrigger.STAFF_PASSWORD_CHANGED]: {
    type: NotificationTrigger.STAFF_PASSWORD_CHANGED,
    emailSubject: () => 'Your password has been changed',
    emailBody: EMAIL_TEMPLATES[NotificationTrigger.STAFF_PASSWORD_CHANGED],
    smsBody: () => 'Your BCKash Cooperative password was just changed. Not you? Contact your Admin.',
  },
  [NotificationTrigger.LOAN_CONSENT_CODE]: {
    type: NotificationTrigger.LOAN_CONSENT_CODE,
    emailSubject: () => 'Confirm your loan application',
    emailBody: EMAIL_TEMPLATES[NotificationTrigger.LOAN_CONSENT_CODE],
    smsBody: (p) =>
      `BCKash loan consent code: ${str(p.code, '')}. Read this to the staff member raising your application. Do not share it otherwise.`,
  },
  // Email-only by design — BranchEventListenersService always dispatches
  // with `phone: null` (see BRANCH_MANAGER_ASSIGNED_EVENT's own doc
  // comment). smsBody is still defined for the same reason every other
  // email-only trigger's is: a manual resend via NotificationAdminController
  // can target any channel, and NotificationTemplateRegistry expects every
  // trigger to render all three.
  [NotificationTrigger.BRANCH_MANAGER_ASSIGNED]: {
    type: NotificationTrigger.BRANCH_MANAGER_ASSIGNED,
    emailSubject: (p) => `You've been assigned as Branch Manager of ${str(p.branchName, 'a branch')}`,
    emailBody: EMAIL_TEMPLATES[NotificationTrigger.BRANCH_MANAGER_ASSIGNED],
    smsBody: (p) => `You've been assigned as Branch Manager of ${str(p.branchName, 'a branch')}.`,
  },
  // Branch-operational triggers for the in-app notification bell — see
  // BranchOperationalEventListenersService/BranchOperationalRecipientsResolver.
  // None define their own inAppTitle/inAppBody — the emailSubject/smsBody
  // fallback (see NotificationTemplate's own doc comment) is short enough
  // to double as bell copy for all eight of these.
  [NotificationTrigger.BRANCH_FUNDING_RECORDED]: {
    type: NotificationTrigger.BRANCH_FUNDING_RECORDED,
    emailSubject: () => 'New funding record awaiting your verification',
    emailBody: EMAIL_TEMPLATES[NotificationTrigger.BRANCH_FUNDING_RECORDED],
    smsBody: (p) => `${naira(p.amountKobo)} funded to ${str(p.branchName, 'your branch')} — please verify or reject.`,
  },
  [NotificationTrigger.BRANCH_FUNDING_VERIFIED]: {
    type: NotificationTrigger.BRANCH_FUNDING_VERIFIED,
    emailSubject: (p) => `Funding record verified — ${str(p.branchName, 'a branch')}`,
    emailBody: EMAIL_TEMPLATES[NotificationTrigger.BRANCH_FUNDING_VERIFIED],
    smsBody: (p) =>
      `${str(p.verifiedByName, 'The branch manager')} verified a ${naira(p.amountKobo)} funding record for ${str(p.branchName, 'a branch')}.`,
  },
  [NotificationTrigger.BRANCH_FUNDING_REJECTED]: {
    type: NotificationTrigger.BRANCH_FUNDING_REJECTED,
    emailSubject: (p) => `Funding record rejected — ${str(p.branchName, 'a branch')}`,
    emailBody: EMAIL_TEMPLATES[NotificationTrigger.BRANCH_FUNDING_REJECTED],
    smsBody: (p) =>
      `${str(p.rejectedByName, 'The branch manager')} rejected a ${naira(p.amountKobo)} funding record for ${str(p.branchName, 'a branch')}: ${str(p.reason, 'no reason given')}.`,
  },
  [NotificationTrigger.BRANCH_FUNDING_DISPUTE_RAISED]: {
    type: NotificationTrigger.BRANCH_FUNDING_DISPUTE_RAISED,
    emailSubject: (p) => `Funding dispute raised — ${str(p.branchName, 'a branch')}`,
    emailBody: EMAIL_TEMPLATES[NotificationTrigger.BRANCH_FUNDING_DISPUTE_RAISED],
    smsBody: (p) =>
      `${str(p.raisedByName, 'The branch manager')} disputed a funding record for ${str(p.branchName, 'a branch')}: ${str(p.reason, 'no reason given')}.`,
  },
  [NotificationTrigger.BRANCH_FUNDING_DISPUTE_RESOLVED]: {
    type: NotificationTrigger.BRANCH_FUNDING_DISPUTE_RESOLVED,
    emailSubject: () => 'Your funding dispute has been resolved',
    emailBody: EMAIL_TEMPLATES[NotificationTrigger.BRANCH_FUNDING_DISPUTE_RESOLVED],
    smsBody: (p) => `${str(p.resolvedByName, 'Head office')} marked your funding dispute as ${str(p.resolution, 'resolved')}.`,
  },
  [NotificationTrigger.BRANCH_REQUEST_RAISED]: {
    type: NotificationTrigger.BRANCH_REQUEST_RAISED,
    emailSubject: (p) => `New request from ${str(p.branchName, 'a branch')}: ${str(p.subject, 'a request')}`,
    emailBody: EMAIL_TEMPLATES[NotificationTrigger.BRANCH_REQUEST_RAISED],
    smsBody: (p) => `${str(p.raisedByName, 'A branch manager')} raised: ${str(p.subject, 'a request')}.`,
  },
  [NotificationTrigger.BRANCH_REQUEST_RESOLVED]: {
    type: NotificationTrigger.BRANCH_REQUEST_RESOLVED,
    emailSubject: () => 'Your request has been resolved',
    emailBody: EMAIL_TEMPLATES[NotificationTrigger.BRANCH_REQUEST_RESOLVED],
    smsBody: (p) => `${str(p.resolvedByName, 'Head office')} resolved your request "${str(p.subject, 'your request')}".`,
  },
  [NotificationTrigger.BRANCH_ROLE_ASSIGNMENT_ASSIGNED]: {
    type: NotificationTrigger.BRANCH_ROLE_ASSIGNMENT_ASSIGNED,
    emailSubject: (p) => `You've been assigned to ${str(p.branchName, 'a branch')}`,
    emailBody: EMAIL_TEMPLATES[NotificationTrigger.BRANCH_ROLE_ASSIGNMENT_ASSIGNED],
    smsBody: (p) => `You are now an assigned ${str(p.role, 'ADMIN')} for ${str(p.branchName, 'a branch')}.`,
  },
  [NotificationTrigger.REPAYMENT_RECORD_SUBMITTED]: {
    type: NotificationTrigger.REPAYMENT_RECORD_SUBMITTED,
    emailSubject: () => 'New repayment awaiting your review',
    emailBody: EMAIL_TEMPLATES[NotificationTrigger.REPAYMENT_RECORD_SUBMITTED],
    smsBody: (p) =>
      `${str(p.recordedByName, 'A marketer')} recorded a repayment of ${naira(p.amountKobo)} for ${str(p.branchName, 'your branch')} — please review.`,
  },
};
