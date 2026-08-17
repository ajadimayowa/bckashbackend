# loans

Loan application (`LoansService`), pre-disbursement verification and
disbursement (`LoanVerificationService`), and minimal pre-loan fee tracking
(`FeePaymentsService`). Built in Phase 8 — see PHASE_8_NOTES.md.

Rebinds Phase 6's `LOAN_STATUS_PORT` (see `groups/loan-status/real-loan-status.port.ts`).
Introduces two more temporary ports of its own — `LEDGER_POSTING_PORT` (Phase
10 must rebind) and `NOTIFICATION_PORT` (Phase 11 must rebind and drain the
`PendingNotificationLog` backlog) — plus an unassigned `BANK_TRANSFER_PORT`
stub with no real provider chosen yet.
