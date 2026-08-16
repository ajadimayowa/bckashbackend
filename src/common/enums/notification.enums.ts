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

/** Trigger points enumerated in the brief — used to pick a template + decide channel(s). */
export enum NotificationTrigger {
  LOAN_RAISED = 'LOAN_RAISED',
  KYC_STATUS_CHANGED = 'KYC_STATUS_CHANGED',
  WORKFLOW_OUTCOME = 'WORKFLOW_OUTCOME',
  DISBURSEMENT_COMPLETED = 'DISBURSEMENT_COMPLETED',
  REPAYMENT_RECORDED = 'REPAYMENT_RECORDED',
  REPAYMENT_DISPUTED = 'REPAYMENT_DISPUTED',
  ACCOUNT_DISABLED = 'ACCOUNT_DISABLED',
  FUNDING_REMINDER = 'FUNDING_REMINDER',
}
