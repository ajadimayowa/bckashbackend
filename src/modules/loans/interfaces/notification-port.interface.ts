export const NOTIFICATION_PORT = Symbol('NOTIFICATION_PORT');

/**
 * *** REAL IMPLEMENTATION IN PHASE 11 — SEE PHASE_11_NOTES.md ***
 *
 * Lets Loans/Repayments depend on "notify about this event" without
 * depending on the Notifications module directly — same pattern as Phase
 * 6's LoanStatusPort. Bound to `RealNotificationPort`
 * (`modules/notifications`) as of Phase 11; `PendingNotificationLogPort`
 * (Phase 8's stub) is retained for tests only — see that class's own doc
 * comment.
 *
 * `sendLoanRaisedNotification`/`sendDisbursementCompleted`/
 * `sendPenaltyCharged` are customer-facing (dispatch straight to the
 * customer). `sendVerificationEscalation`/`sendRepaymentDisputeRaised` are
 * staff-facing — `RealNotificationPort` resolves the involved parties (see
 * `InvolvedPartiesResolver`) rather than notifying the customer directly,
 * per the brief's own confirmed policy. `sendVerificationEscalation` kept
 * its Phase 8 signature unchanged (`loanId`/`customerId`/`reason` only) —
 * `RealNotificationPort` resolves `branchId`/`raisedBy`/
 * `relatedWorkflowRequestId` internally from the Loan record rather than
 * widening this signature, since the brief didn't ask for that reconciliation
 * the way it did for `sendRepaymentDisputeRaised` below.
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
  /**
   * Added in Phase 9 (`modules/repayments`) — reused for BOTH an overdue-
   * installment penalty charge and an early-liquidation recurring delay
   * charge (a delay charge is functionally a penalty, just scoped to a
   * liquidation request — see `LedgerPostingPort.postPenalty`'s identical
   * reuse). `context` is a short human-readable description of which charge
   * this is (e.g. "Installment 3 recurring overdue penalty (period 1)").
   */
  sendPenaltyCharged(customerId: string, amountKobo: number, context: string): Promise<void>;
  /**
   * *** PHASE 11 CROSS-PHASE RETROFIT — SEE PHASE_11_NOTES.md ***
   * Phase 9's `RepaymentsService.raiseDispute` never called `NotificationPort`
   * when it was built (out of scope at the time) — added now. Staff-facing:
   * resolved via `InvolvedPartiesResolver` with `initiatedBy: recordedBy`
   * (the marketer who originally recorded the repayment).
   */
  sendRepaymentDisputeRaised(params: {
    repaymentRecordId: string;
    branchId: string;
    recordedBy: string;
    raisedBy: string;
    reason: string;
    relatedWorkflowRequestId: string;
  }): Promise<void>;
}
