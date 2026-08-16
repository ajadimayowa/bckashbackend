import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { WorkflowEngineModule } from '../../platform/workflow-engine/workflow-engine.module';
// Cross-module schema registration only — see groups.service.ts's comment
// and PHASE_3_NOTES.md ("cross-module existence checks").
import { Branch, BranchSchema } from '../branches/schemas/branch.schema';
import { CustomersModule } from '../customers/customers.module';
import { Customer, CustomerSchema } from '../customers/schemas/customer.schema';
import { IdentityModule } from '../identity/identity.module';
import { GroupsController } from './groups.controller';
import { GroupsService } from './groups.service';
import { LOAN_STATUS_PORT } from './interfaces/loan-status-port.interface';
import { StubLoanStatusPort } from './loan-status/stub-loan-status.port';
import { GroupMembership, GroupMembershipSchema } from './schemas/group-membership.schema';
import { Group, GroupSchema } from './schemas/group.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Group.name, schema: GroupSchema },
      { name: GroupMembership.name, schema: GroupMembershipSchema },
      { name: Branch.name, schema: BranchSchema },
      { name: Customer.name, schema: CustomerSchema },
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
    // *** TEMPORARY — see PHASE_6_NOTES.md and LoanStatusPort's own doc
    // comment. Phase 8 (Loans) MUST replace this binding with a real
    // implementation backed by the Loan collection — StubLoanStatusPort
    // always returns `false`, which is only correct until Phase 8 ships. ***
    { provide: LOAN_STATUS_PORT, useClass: StubLoanStatusPort },
  ],
  exports: [GroupsService],
})
export class GroupsModule {}
