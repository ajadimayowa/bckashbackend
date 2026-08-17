import { Injectable } from '@nestjs/common';

import { LoanStatusPort } from '../interfaces/loan-status-port.interface';

/**
 * *** SUPERSEDED BY RealLoanStatusPort AS OF PHASE 8 — SEE PHASE_8_NOTES.md ***
 * Always `false`. `groups.module.ts` no longer binds `LOAN_STATUS_PORT` to
 * this class in production — see `real-loan-status.port.ts`. Kept only as a
 * convenience for tests that want to stub the "no pending loan" check without
 * standing up real MemberLoanAccount data (e.g. GroupsService unit tests that
 * predate Phase 8 and aren't exercising this guard).
 */
@Injectable()
export class StubLoanStatusPort implements LoanStatusPort {
  hasPendingLoan(_customerId: string): Promise<boolean> {
    return Promise.resolve(false);
  }
}
