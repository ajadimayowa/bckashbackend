import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { IdentityModule } from '../identity/identity.module';
// Cross-module schema registration only — see branch-manager-assignment.service.ts's
// comment and PHASE_3_NOTES.md. IdentityModule is imported only for JwtAuthGuard.
import { Staff, StaffSchema } from '../identity/schemas/staff.schema';
import { BranchBankAccountsController } from './branch-bank-accounts.controller';
import { BranchBankAccountsService } from './branch-bank-accounts.service';
import { BranchFundBalanceService } from './branch-fund-balance.service';
import { BranchFundingController } from './branch-funding.controller';
import { BranchFundingService } from './branch-funding.service';
import { BranchManagerAssignmentService } from './branch-manager-assignment.service';
import { BranchesController } from './branches.controller';
import { BranchesService } from './branches.service';
import { BranchBankAccount, BranchBankAccountSchema } from './schemas/branch-bank-account.schema';
import { BranchFundBalance, BranchFundBalanceSchema } from './schemas/branch-fund-balance.schema';
import { BranchFunding, BranchFundingSchema } from './schemas/branch-funding.schema';
import {
  BranchManagerAssignment,
  BranchManagerAssignmentSchema,
} from './schemas/branch-manager-assignment.schema';
import { Branch, BranchSchema } from './schemas/branch.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Branch.name, schema: BranchSchema },
      { name: BranchManagerAssignment.name, schema: BranchManagerAssignmentSchema },
      { name: BranchBankAccount.name, schema: BranchBankAccountSchema },
      { name: BranchFunding.name, schema: BranchFundingSchema },
      { name: BranchFundBalance.name, schema: BranchFundBalanceSchema },
      { name: Staff.name, schema: StaffSchema },
    ]),
    IdentityModule,
  ],
  controllers: [BranchesController, BranchBankAccountsController, BranchFundingController],
  providers: [
    BranchesService,
    BranchManagerAssignmentService,
    BranchBankAccountsService,
    BranchFundBalanceService,
    BranchFundingService,
  ],
  exports: [
    BranchesService,
    BranchManagerAssignmentService,
    BranchBankAccountsService,
    BranchFundBalanceService,
    BranchFundingService,
  ],
})
export class BranchesModule {}
