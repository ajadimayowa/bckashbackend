export const NOTIFICATION_PORT = Symbol('NOTIFICATION_PORT');

/**
 * *** TEMPORARY PORT — SEE PHASE_8_NOTES.md — MUST BE REBOUND IN PHASE 11 ***
 *
 * Lets Loans depend on "notify this customer" without depending on the
 * Notifications module directly — same pattern as Phase 6's LoanStatusPort.
 * `loans.module.ts` currently binds this to a stub that writes to
 * `PendingNotificationLog` instead of actually sending an email/SMS — see that
 * class's own doc comment for what Phase 11 must do with the resulting backlog.
 */
export interface NotificationPort {
  sendLoanRaisedNotification(
    customerId: string,
    memberAmountKobo: number,
    groupCumulativeAmountKobo: number,
    raisedAt: Date,
  ): Promise<void>;
  sendVerificationEscalation(loanId: string, customerId: string, reason: string): Promise<void>;
  sendDisbursementCompleted(customerId: string, amountKobo: number, channel: string): Promise<void>;
}
