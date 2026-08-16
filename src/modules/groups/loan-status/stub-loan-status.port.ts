import { Injectable } from '@nestjs/common';

import { LoanStatusPort } from '../interfaces/loan-status-port.interface';

/**
 * *** TEMPORARY — SEE PHASE_6_NOTES.md — MUST BE REPLACED IN PHASE 8 ***
 * Always `false`: no Loan collection exists yet in this codebase, so no
 * customer can have a pending loan. Once Phase 8 ships real loans, this
 * binding must be swapped for a real implementation in `groups.module.ts` —
 * leaving this stub wired up past Phase 8 would silently let every member
 * removal bypass the "no pending loan" guard.
 */
@Injectable()
export class StubLoanStatusPort implements LoanStatusPort {
  hasPendingLoan(_customerId: string): Promise<boolean> {
    return Promise.resolve(false);
  }
}
