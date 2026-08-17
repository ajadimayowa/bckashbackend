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
 * Trigger points enumerated in the brief — used to pick a template + decide channel(s).
 * `VERIFICATION_ESCALATED` is an addition made in Phase 8 (not in the original Phase
 * 1/2 placeholder set) — the brief's `NotificationPort.sendVerificationEscalation`
 * needed a trigger value and none of the pre-existing ones fit (it isn't a
 * WORKFLOW_OUTCOME — no WorkflowRequest is involved in a disbursement-verification
 * escalation). Purely additive; every other value here is untouched. See PHASE_8_NOTES.md.
 */
export enum NotificationTrigger {
  LOAN_RAISED = 'LOAN_RAISED',
  KYC_STATUS_CHANGED = 'KYC_STATUS_CHANGED',
  WORKFLOW_OUTCOME = 'WORKFLOW_OUTCOME',
  VERIFICATION_ESCALATED = 'VERIFICATION_ESCALATED',
  DISBURSEMENT_COMPLETED = 'DISBURSEMENT_COMPLETED',
  REPAYMENT_RECORDED = 'REPAYMENT_RECORDED',
  REPAYMENT_DISPUTED = 'REPAYMENT_DISPUTED',
  ACCOUNT_DISABLED = 'ACCOUNT_DISABLED',
  FUNDING_REMINDER = 'FUNDING_REMINDER',
}
