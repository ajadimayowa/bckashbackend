import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { IdentityModule } from '../identity/identity.module';
// Cross-module schema registration only — see branch-manager-assignment.service.ts's
// comment and PHASE_3_NOTES.md. IdentityModule is imported only for JwtAuthGuard.
import { Staff, StaffSchema } from '../identity/schemas/staff.schema';
import { BranchManagerAssignmentService } from './branch-manager-assignment.service';
import { BranchesController } from './branches.controller';
import { BranchesService } from './branches.service';
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
      { name: Staff.name, schema: StaffSchema },
    ]),
    IdentityModule,
  ],
  controllers: [BranchesController],
  providers: [BranchesService, BranchManagerAssignmentService],
  exports: [BranchesService, BranchManagerAssignmentService],
})
export class BranchesModule {}
