import { NotificationTrigger } from '../../../../common/enums/notification.enums';
import { accountDisabledEmail } from './account-disabled.email';
import { branchFundingDisputeRaisedEmail } from './branch-funding-dispute-raised.email';
import { branchFundingDisputeResolvedEmail } from './branch-funding-dispute-resolved.email';
import { branchFundingRecordedEmail } from './branch-funding-recorded.email';
import { branchFundingRejectedEmail } from './branch-funding-rejected.email';
import { branchFundingVerifiedEmail } from './branch-funding-verified.email';
import { branchManagerAssignedEmail } from './branch-manager-assigned.email';
import { branchRequestRaisedEmail } from './branch-request-raised.email';
import { branchRequestResolvedEmail } from './branch-request-resolved.email';
import { branchRoleAssignmentAssignedEmail } from './branch-role-assignment-assigned.email';
import { disbursementCompletedEmail } from './disbursement-completed.email';
import { fundingReminderEmail } from './funding-reminder.email';
import { kycStatusChangedEmail } from './kyc-status-changed.email';
import { loanApprovedEmail } from './loan-approved.email';
import { loanConsentCodeEmail } from './loan-consent-code.email';
import { loanRaisedEmail } from './loan-raised.email';
import { loginOtpEmail } from './login-otp.email';
import { passwordResetConfirmationEmail } from './password-reset-confirmation.email';
import { passwordResetOtpEmail } from './password-reset-otp.email';
import { penaltyChargedEmail } from './penalty-charged.email';
import { repaymentDisputedEmail } from './repayment-disputed.email';
import { repaymentRecordedEmail } from './repayment-recorded.email';
import { repaymentRecordSubmittedEmail } from './repayment-record-submitted.email';
import { staffOnboardingOutcomeEmail } from './staff-onboarding-outcome.email';
import { staffPasswordChangedEmail } from './staff-password-changed.email';
import { staffWelcomeEmail } from './staff-welcome.email';
import { verificationEscalatedEmail } from './verification-escalated.email';
import { workflowOutcomeEmail } from './workflow-outcome.email';

/**
 * One branded HTML template per `NotificationTrigger` — each file in this
 * folder owns its own content, all sharing `email-layout.ts`'s wrapper
 * (BCKash Cooperative header/footer). `NotificationTemplateRegistry`'s own
 * boot-time completeness check (see ../notification-template-registry.service.ts)
 * doesn't reach in here directly, but `notification-templates.ts` wires
 * every one of these into `emailBody` below, so the same "every
 * NotificationTrigger has a template" guarantee holds transitively.
 */
export const EMAIL_TEMPLATES: Record<
  NotificationTrigger,
  (payload: Record<string, unknown>) => string
> = {
  [NotificationTrigger.LOAN_RAISED]: loanRaisedEmail,
  [NotificationTrigger.LOAN_APPROVED]: loanApprovedEmail,
  [NotificationTrigger.KYC_STATUS_CHANGED]: kycStatusChangedEmail,
  [NotificationTrigger.WORKFLOW_OUTCOME]: workflowOutcomeEmail,
  [NotificationTrigger.VERIFICATION_ESCALATED]: verificationEscalatedEmail,
  [NotificationTrigger.DISBURSEMENT_COMPLETED]: disbursementCompletedEmail,
  [NotificationTrigger.REPAYMENT_RECORDED]: repaymentRecordedEmail,
  [NotificationTrigger.REPAYMENT_DISPUTED]: repaymentDisputedEmail,
  [NotificationTrigger.PENALTY_CHARGED]: penaltyChargedEmail,
  [NotificationTrigger.ACCOUNT_DISABLED]: accountDisabledEmail,
  [NotificationTrigger.FUNDING_REMINDER]: fundingReminderEmail,
  [NotificationTrigger.STAFF_ONBOARDING_OUTCOME]: staffOnboardingOutcomeEmail,
  [NotificationTrigger.STAFF_WELCOME]: staffWelcomeEmail,
  [NotificationTrigger.LOGIN_OTP]: loginOtpEmail,
  [NotificationTrigger.PASSWORD_RESET_OTP]: passwordResetOtpEmail,
  [NotificationTrigger.PASSWORD_RESET_CONFIRMATION]: passwordResetConfirmationEmail,
  [NotificationTrigger.STAFF_PASSWORD_CHANGED]: staffPasswordChangedEmail,
  [NotificationTrigger.LOAN_CONSENT_CODE]: loanConsentCodeEmail,
  [NotificationTrigger.BRANCH_MANAGER_ASSIGNED]: branchManagerAssignedEmail,
  [NotificationTrigger.BRANCH_FUNDING_RECORDED]: branchFundingRecordedEmail,
  [NotificationTrigger.BRANCH_FUNDING_VERIFIED]: branchFundingVerifiedEmail,
  [NotificationTrigger.BRANCH_FUNDING_REJECTED]: branchFundingRejectedEmail,
  [NotificationTrigger.BRANCH_FUNDING_DISPUTE_RAISED]: branchFundingDisputeRaisedEmail,
  [NotificationTrigger.BRANCH_FUNDING_DISPUTE_RESOLVED]: branchFundingDisputeResolvedEmail,
  [NotificationTrigger.BRANCH_REQUEST_RAISED]: branchRequestRaisedEmail,
  [NotificationTrigger.BRANCH_REQUEST_RESOLVED]: branchRequestResolvedEmail,
  [NotificationTrigger.BRANCH_ROLE_ASSIGNMENT_ASSIGNED]: branchRoleAssignmentAssignedEmail,
  [NotificationTrigger.REPAYMENT_RECORD_SUBMITTED]: repaymentRecordSubmittedEmail,
};
