import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { WorkflowEngineModule } from '../../platform/workflow-engine/workflow-engine.module';
import { BranchesModule } from '../branches/branches.module';
import { IdentityModule } from '../identity/identity.module';
import { HrLeaveController } from './hr-leave.controller';
import { HrSalaryController } from './hr-salary.controller';
import { LeaveApplicationService } from './leave-application.service';
import { LeaveBalanceService } from './leave-balance.service';
import { LeaveTypeController } from './leave-type.controller';
import { LeaveTypeService } from './leave-type.service';
import { SalaryService } from './salary.service';
import { LeaveApplication, LeaveApplicationSchema } from './schemas/leave-application.schema';
import { LeaveBalance, LeaveBalanceSchema } from './schemas/leave-balance.schema';
import { LeaveType, LeaveTypeSchema } from './schemas/leave-type.schema';
import { SalaryRecord, SalaryRecordSchema } from './schemas/salary-record.schema';

/**
 * The last module in the 12-phase build — self-contained, no forward-
 * dependency ports for a later phase to rebind. Reuses the workflow engine,
 * RBAC, audit, and encryption services built in earlier phases rather than
 * building equivalents. See PHASE_12_NOTES.md.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: LeaveType.name, schema: LeaveTypeSchema },
      { name: LeaveBalance.name, schema: LeaveBalanceSchema },
      { name: LeaveApplication.name, schema: LeaveApplicationSchema },
      { name: SalaryRecord.name, schema: SalaryRecordSchema },
    ]),
    WorkflowEngineModule,
    IdentityModule,
    BranchesModule,
  ],
  controllers: [LeaveTypeController, HrLeaveController, HrSalaryController],
  providers: [LeaveTypeService, LeaveBalanceService, LeaveApplicationService, SalaryService],
  exports: [LeaveTypeService, LeaveBalanceService, LeaveApplicationService, SalaryService],
})
export class HrModule {}
