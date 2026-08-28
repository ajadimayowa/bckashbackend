export enum NotificationChannel {
  EMAIL = 'EMAIL',
  SMS = 'SMS',
}

export enum NotificationStatus {
  QUEUED = 'QUEUED',
  SENT = 'SENT',
  FAILED = 'FAILED',
  DEAD_LETTER = 'DEAD_LETTER',
}

/**
 * How a persisted in-app Notification (see modules/notifications/schemas/notification.schema.ts)
 * is grouped for display/routing purposes — distinct from `NotificationChannel`
 * (EMAIL/SMS/in-app-the-delivery-mechanism); this is about *why* the
 * recipient got it. `SUPERADMIN_MIRROR` marks a fan-out copy specifically
 * (see NotificationInboxService.persistCopies) so a SuperAdmin's own inbox
 * can still tell "this landed in my inbox because I'm a SuperAdmin, not
 * because I'm this branch's assigned manager/admin/approver" apart, even
 * though every SuperAdmin also gets a mirror of every BRANCH_MANAGER/
 * BRANCH_ADMIN_APPROVER notification too.
 */
export enum NotificationCategory {
  BRANCH_MANAGER = 'BRANCH_MANAGER',
  BRANCH_ADMIN_APPROVER = 'BRANCH_ADMIN_APPROVER',
  SUPERADMIN_MIRROR = 'SUPERADMIN_MIRROR',
  GENERAL = 'GENERAL',
}

/**
 * Trigger points enumerated in the brief — used to pick a template + decide channel(s).
 * `VERIFICATION_ESCALATED` is an addition made in Phase 8 (not in the original Phase
 * 1/2 placeholder set) — the brief's `NotificationPort.sendVerificationEscalation`
 * needed a trigger value and none of the pre-existing ones fit (it isn't a
 * WORKFLOW_OUTCOME — no WorkflowRequest is involved in a disbursement-verification
 * escalation). Purely additive; every other value here is untouched. See PHASE_8_NOTES.md.
 */
export enum NotificationTrigger {
  LOAN_RAISED = 'LOAN_RAISED',
  // Fired once per member the moment their group's loan clears its full
  // approval chain (LoansService.handleWorkflowApproved) — tells the
  // applicant to come in for disbursement verification, distinct from
  // DISBURSEMENT_COMPLETED below (which fires only once verification has
  // actually passed and the money has moved).
  LOAN_APPROVED = 'LOAN_APPROVED',
  KYC_STATUS_CHANGED = 'KYC_STATUS_CHANGED',
  WORKFLOW_OUTCOME = 'WORKFLOW_OUTCOME',
  VERIFICATION_ESCALATED = 'VERIFICATION_ESCALATED',
  DISBURSEMENT_COMPLETED = 'DISBURSEMENT_COMPLETED',
  REPAYMENT_RECORDED = 'REPAYMENT_RECORDED',
  REPAYMENT_DISPUTED = 'REPAYMENT_DISPUTED',
  // Added in Phase 9 — NotificationPort.sendPenaltyCharged. See PHASE_9_NOTES.md.
  PENALTY_CHARGED = 'PENALTY_CHARGED',
  ACCOUNT_DISABLED = 'ACCOUNT_DISABLED',
  FUNDING_REMINDER = 'FUNDING_REMINDER',
  // Added in Phase 11 — no call site yet (Phase 12/HR's job to wire), but a
  // template is registered for it now per the brief's own NotificationType
  // list. See PHASE_11_NOTES.md.
  STAFF_ONBOARDING_OUTCOME = 'STAFF_ONBOARDING_OUTCOME',
  // Fired once, right after a Staff document is created (either creation
  // path) — carries the system-generated temporary password. Deliberately
  // distinct from STAFF_ONBOARDING_OUTCOME above (that one's about the
  // workflow *decision*, has no call site yet, and never carries a
  // credential). See identity/events/staff.events.ts, PHASE_11_NOTES.md's
  // successor work.
  STAFF_WELCOME = 'STAFF_WELCOME',
  // The OTP step of the two-step login flow (see AuthOtpService). Dispatched
  // outside the request/response cycle via LOGIN_OTP_ISSUED_EVENT, same as
  // STAFF_WELCOME — see identity/events/auth-otp.events.ts.
  LOGIN_OTP = 'LOGIN_OTP',
  // The forgot-password flow's code step (see PasswordResetService) — a
  // staff member who cannot log in requests this without authenticating.
  // Dispatched via PASSWORD_RESET_REQUESTED_EVENT, same shape as LOGIN_OTP.
  // See identity/events/password-reset.events.ts.
  PASSWORD_RESET_OTP = 'PASSWORD_RESET_OTP',
  // Confirmation sent right after a successful forgot-password reset, via
  // PASSWORD_RESET_COMPLETED_EVENT — so a reset the staff member didn't
  // make gets noticed.
  PASSWORD_RESET_CONFIRMATION = 'PASSWORD_RESET_CONFIRMATION',
  // Confirmation sent right after a self-service password change — the
  // staff member was already logged in (POST /auth/change-password), via
  // STAFF_PASSWORD_CHANGED_EVENT. Distinct from PASSWORD_RESET_CONFIRMATION
  // above (that one's the no-login forgot-password path) so the email
  // names the right flow. See identity/events/staff.events.ts.
  STAFF_PASSWORD_CHANGED = 'STAFF_PASSWORD_CHANGED',
  // The customer-consent step of raising a loan (see modules/loans/loan-
  // consent.service.ts) — a marketer triggers this, the code is read back to
  // them by the customer over the phone/in person and entered into the raise-
  // application form. Customer-facing (NotificationPort.sendLoanConsentCode),
  // same "SMS/email, short-lived, single-use" shape as LOGIN_OTP.
  LOAN_CONSENT_CODE = 'LOAN_CONSENT_CODE',
  // Fired once a branch manager assignment proposal is approved and
  // applied (see BranchManagerAssignmentService, BRANCH_MANAGER_ASSIGNED_EVENT)
  // — tells the newly-assigned staff member they're now managing that
  // branch. Email-only by design (BranchEventListenersService dispatches
  // with `phone: null`) — same posture as STAFF_PASSWORD_CHANGED/
  // PASSWORD_RESET_OTP above.
  BRANCH_MANAGER_ASSIGNED = 'BRANCH_MANAGER_ASSIGNED',
  // Branch-operational triggers added for the in-app notification bell (see
  // modules/notifications/branch-operational-event-listeners.service.ts) —
  // all staff-facing, all routed via BranchOperationalRecipientsResolver to
  // the branch's manager and/or its assigned admins/approvers.
  BRANCH_FUNDING_RECORDED = 'BRANCH_FUNDING_RECORDED',
  BRANCH_FUNDING_VERIFIED = 'BRANCH_FUNDING_VERIFIED',
  BRANCH_FUNDING_REJECTED = 'BRANCH_FUNDING_REJECTED',
  BRANCH_FUNDING_DISPUTE_RAISED = 'BRANCH_FUNDING_DISPUTE_RAISED',
  BRANCH_FUNDING_DISPUTE_RESOLVED = 'BRANCH_FUNDING_DISPUTE_RESOLVED',
  BRANCH_REQUEST_RAISED = 'BRANCH_REQUEST_RAISED',
  BRANCH_REQUEST_RESOLVED = 'BRANCH_REQUEST_RESOLVED',
  // Fired once per branch in the approved batch (see
  // BranchStaffRoleAssignmentService, BRANCH_ROLE_ASSIGNED_EVENT) — tells
  // the newly-assigned staff member they're now covering that branch.
  BRANCH_ROLE_ASSIGNMENT_ASSIGNED = 'BRANCH_ROLE_ASSIGNMENT_ASSIGNED',
  // Fired right after a marketer records a repayment (RepaymentsService.
  // recordRepayment, before either workflow step has run) — tells the
  // branch's current manager a REPAYMENT_RECORD is waiting on their review
  // step. Staff-facing; deliberately distinct from REPAYMENT_RECORDED above
  // (that one is the customer-facing "thanks for paying" receipt — this one
  // has never had a call site). See NotificationPort.sendRepaymentSubmittedForReview.
  REPAYMENT_RECORD_SUBMITTED = 'REPAYMENT_RECORD_SUBMITTED',
}
