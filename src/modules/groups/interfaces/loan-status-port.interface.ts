export const LOAN_STATUS_PORT = Symbol('LOAN_STATUS_PORT');

/**
 * *** TEMPORARY PORT — SEE PHASE_6_NOTES.md — MUST BE REBOUND IN PHASE 8 ***
 *
 * Group membership removal must be blocked while a member has a pending
 * loan, but the Loans module doesn't exist until Phase 8. This port lets
 * GroupsService depend on "can this customer's membership be removed
 * right now?" without depending on Loans directly. `groups.module.ts`
 * currently binds this token to `StubLoanStatusPort`, which always returns
 * `false` (no loan can exist yet, so nothing is ever pending) — that is only
 * correct until Phase 8 ships a real Loan collection. Phase 8 MUST replace
 * the `useClass`/`useExisting` binding for `LOAN_STATUS_PORT` in
 * `groups.module.ts` with an implementation backed by real loan data, or
 * every future member removal will silently sail through this guard.
 */
export interface LoanStatusPort {
  hasPendingLoan(customerId: string): Promise<boolean>;
}
