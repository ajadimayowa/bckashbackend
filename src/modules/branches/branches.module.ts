import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AuditModule } from '../../platform/audit/audit.module';
import { S3IntegrationModule } from '../../platform/integrations/s3/s3.module';
import { WorkflowEngineModule } from '../../platform/workflow-engine/workflow-engine.module';
import { IdentityModule } from '../identity/identity.module';
// Cross-module schema registration only — see branch-manager-assignment.service.ts's
// comment and PHASE_3_NOTES.md. IdentityModule is imported only for JwtAuthGuard.
import { Staff, StaffSchema } from '../identity/schemas/staff.schema';
// Same cross-module raw-model pattern, for BranchesService.getStats — see its
// own doc comment. Not importing LoansModule itself (avoids any risk of a
// circular module dependency; this is schema registration only).
import { Loan, LoanSchema } from '../loans/schemas/loan.schema';
// Same pattern again — for BranchesService.deleteBranch's own reference
// check (see its doc comment). Neither CustomersModule nor GroupsModule
// imports BranchesModule, so there's no cycle risk here either.
import { Customer, CustomerSchema } from '../customers/schemas/customer.schema';
import { Group, GroupSchema } from '../groups/schemas/group.schema';
import { BranchBankAccountsController } from './branch-bank-accounts.controller';
import { BranchBankAccountsService } from './branch-bank-accounts.service';
import { BranchFundBalanceService } from './branch-fund-balance.service';
import { BranchFundingController } from './branch-funding.controller';
import { BranchFundingService } from './branch-funding.service';
import { BranchManagerAssignmentService } from './branch-manager-assignment.service';
import { BranchRequestsController } from './branch-requests.controller';
import { BranchRequestsService } from './branch-requests.service';
import { BranchStaffRoleAssignmentController } from './branch-staff-role-assignment.controller';
import { BranchStaffRoleAssignmentService } from './branch-staff-role-assignment.service';
import { BranchesController } from './branches.controller';
import { BranchesService } from './branches.service';
import { BranchBankAccount, BranchBankAccountSchema } from './schemas/branch-bank-account.schema';
import { BranchFundBalance, BranchFundBalanceSchema } from './schemas/branch-fund-balance.schema';
import { BranchFunding, BranchFundingSchema } from './schemas/branch-funding.schema';
import {
  BranchManagerAssignment,
  BranchManagerAssignmentSchema,
} from './schemas/branch-manager-assignment.schema';
import { BranchRequest, BranchRequestSchema } from './schemas/branch-request.schema';
import {
  BranchStaffRoleAssignment,
  BranchStaffRoleAssignmentSchema,
} from './schemas/branch-staff-role-assignment.schema';
import { Branch, BranchSchema } from './schemas/branch.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Branch.name, schema: BranchSchema },
      { name: BranchManagerAssignment.name, schema: BranchManagerAssignmentSchema },
      { name: BranchStaffRoleAssignment.name, schema: BranchStaffRoleAssignmentSchema },
      { name: BranchBankAccount.name, schema: BranchBankAccountSchema },
      { name: BranchFunding.name, schema: BranchFundingSchema },
      { name: BranchFundBalance.name, schema: BranchFundBalanceSchema },
      { name: BranchRequest.name, schema: BranchRequestSchema },
      { name: Staff.name, schema: StaffSchema },
      { name: Loan.name, schema: LoanSchema },
      { name: Customer.name, schema: CustomerSchema },
      { name: Group.name, schema: GroupSchema },
    ]),
    IdentityModule,
    AuditModule,
    WorkflowEngineModule,
    S3IntegrationModule,
  ],
  controllers: [
    BranchesController,
    BranchBankAccountsController,
    BranchFundingController,
    BranchRequestsController,
    BranchStaffRoleAssignmentController,
  ],
  providers: [
    BranchesService,
    BranchManagerAssignmentService,
    BranchStaffRoleAssignmentService,
    BranchBankAccountsService,
    BranchFundBalanceService,
    BranchFundingService,
    BranchRequestsService,
  ],
  exports: [
    BranchesService,
    BranchManagerAssignmentService,
    BranchStaffRoleAssignmentService,
    BranchBankAccountsService,
    BranchFundBalanceService,
    BranchFundingService,
    BranchRequestsService,
  ],
})
export class BranchesModule {}
