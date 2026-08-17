import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { MemberLoanAccountStatus } from '../../../common/enums/loan.enums';
// Raw model injection only — the Loans module's *schema*, not LoansModule
// itself. Importing LoansModule here would create a circular module
// dependency (LoansModule already imports GroupsModule for
// GroupsService.isEligibleForLoanApplication/getActiveMembers). This is the
// exact same "cross-module existence checks via a raw injected model" pattern
// GroupsModule already uses for Branch/Customer — see groups.service.ts's own
// comment and PHASE_3_NOTES.md. See PHASE_8_NOTES.md for why this file lives
// here (in groups/) rather than in loans/: LoanStatusPort is GroupsService's
// own interface, and the whole point of the port was to let GroupsModule
// avoid depending on LoansModule directly (see loan-status-port.interface.ts).
import {
  MemberLoanAccount,
  MemberLoanAccountDocument,
} from '../../loans/schemas/member-loan-account.schema';
import { LoanStatusPort } from '../interfaces/loan-status-port.interface';

/**
 * *** THE REAL BINDING — REPLACES StubLoanStatusPort AS OF PHASE 8 ***
 * A customer "has a pending loan" iff they hold a MemberLoanAccount whose
 * status is PENDING (raised, not yet disbursed) or ACTIVE (disbursed,
 * outstanding balance not yet fully repaid) — CLOSED and DEFAULTED both allow
 * removal. Exactly the query given in Phase 8's brief.
 */
@Injectable()
export class RealLoanStatusPort implements LoanStatusPort {
  constructor(
    @InjectModel(MemberLoanAccount.name)
    private readonly memberLoanAccountModel: Model<MemberLoanAccountDocument>,
  ) {}

  async hasPendingLoan(customerId: string): Promise<boolean> {
    const exists = await this.memberLoanAccountModel.exists({
      customerId: new Types.ObjectId(customerId),
      status: {
        $in: [MemberLoanAccountStatus.PENDING, MemberLoanAccountStatus.ACTIVE],
      },
    });
    return Boolean(exists);
  }
}
