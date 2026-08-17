export const LOAN_STATUS_PORT = Symbol('LOAN_STATUS_PORT');

/**
 * *** REBOUND IN PHASE 8 — SEE PHASE_8_NOTES.md ***
 *
 * Group membership removal is blocked while a member has a pending loan.
 * This port lets GroupsService depend on "can this customer's membership be
 * removed right now?" without depending on the Loans module directly —
 * `groups.module.ts` now binds this token to `RealLoanStatusPort`
 * (`groups/loan-status/real-loan-status.port.ts`), backed by the Loans
 * module's `MemberLoanAccount` collection (imported as a raw schema only, to
 * avoid a circular module dependency — see that file's own comment).
 * `StubLoanStatusPort` (always `false`) is kept in the codebase only as a
 * lightweight fallback for tests that don't need real loan data — it is no
 * longer wired up in `groups.module.ts`.
 */
export interface LoanStatusPort {
  hasPendingLoan(customerId: string): Promise<boolean>;
}
