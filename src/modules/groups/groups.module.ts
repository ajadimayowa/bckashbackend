import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { WorkflowEngineModule } from '../../platform/workflow-engine/workflow-engine.module';
// Cross-module schema registration only — see groups.service.ts's comment
// and PHASE_3_NOTES.md ("cross-module existence checks"). MemberLoanAccount
// is the Phase 8 addition — RealLoanStatusPort reads it directly; see that
// file's own comment for why this is a raw schema import, not a LoansModule
// import (which would be circular, since LoansModule imports GroupsModule).
import { Branch, BranchSchema } from '../branches/schemas/branch.schema';
import { CustomersModule } from '../customers/customers.module';
import { Customer, CustomerSchema } from '../customers/schemas/customer.schema';
import { IdentityModule } from '../identity/identity.module';
import {
  MemberLoanAccount,
  MemberLoanAccountSchema,
} from '../loans/schemas/member-loan-account.schema';
import { GroupsController } from './groups.controller';
import { GroupsService } from './groups.service';
import { LOAN_STATUS_PORT } from './interfaces/loan-status-port.interface';
import { RealLoanStatusPort } from './loan-status/real-loan-status.port';
import { GroupMembership, GroupMembershipSchema } from './schemas/group-membership.schema';
import { Group, GroupSchema } from './schemas/group.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Group.name, schema: GroupSchema },
      { name: GroupMembership.name, schema: GroupMembershipSchema },
      { name: Branch.name, schema: BranchSchema },
      { name: Customer.name, schema: CustomerSchema },
      { name: MemberLoanAccount.name, schema: MemberLoanAccountSchema },
    ]),
    WorkflowEngineModule,
    // CustomersModule (not just its schema) — GroupsService calls
    // CustomerService.isLoanEligible directly, exported from CustomersModule.
    CustomersModule,
    IdentityModule,
  ],
  controllers: [GroupsController],
  providers: [
    GroupsService,
    // *** REBOUND IN PHASE 8 — see PHASE_8_NOTES.md and LoanStatusPort's own
    // doc comment. RealLoanStatusPort reads real MemberLoanAccount data
    // (imported as a schema above, not via LoansModule — see that file's
    // comment on why). StubLoanStatusPort (always `false`) is no longer
    // wired up here. ***
    { provide: LOAN_STATUS_PORT, useClass: RealLoanStatusPort },
  ],
  exports: [GroupsService],
})
export class GroupsModule {}
