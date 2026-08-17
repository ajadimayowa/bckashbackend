import { randomBytes } from 'node:crypto';

import { EventEmitterModule } from '@nestjs/event-emitter';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model, Types } from 'mongoose';

import { __resetPiiEncryptionKeyCache } from '../../../common/crypto/pii-encryption';
import { ModuleName, StaffRole, StaffStatus } from '../../../common/enums/identity.enums';
import { WorkflowEntityType, WorkflowStepAction } from '../../../common/enums/workflow.enums';
import { AuditModule } from '../../../platform/audit/audit.module';
import { EncryptionService } from '../../../platform/encryption/encryption.service';
import { BvnCallLogService } from '../../../platform/integrations/bvn/bvn-call-log.service';
import { BVN_VERIFICATION_ADAPTER } from '../../../platform/integrations/bvn/interfaces/bvn-verification-adapter.interface';
import { MockBvnVerificationAdapter } from '../../../platform/integrations/bvn/mock-bvn-verification.adapter';
import {
  BvnCallLog,
  BvnCallLogSchema,
} from '../../../platform/integrations/bvn/schemas/bvn-call-log.schema';
import { approveCapability, reviewCapability } from '../../../platform/rbac/constants/capabilities';
import { ActingStaff } from '../../../platform/workflow-engine/interfaces/workflow-engine.interfaces';
import {
  WorkflowChainConfig,
  WorkflowChainConfigSchema,
} from '../../../platform/workflow-engine/schemas/workflow-chain-config.schema';
import {
  WorkflowRequest,
  WorkflowRequestDocument,
  WorkflowRequestSchema,
} from '../../../platform/workflow-engine/schemas/workflow-request.schema';
import { WorkflowEngineService } from '../../../platform/workflow-engine/workflow-engine.service';
import { InMemoryMongo } from '../../../test-utils/in-memory-mongo';
import { BranchManagerAssignmentService } from '../../branches/branch-manager-assignment.service';
import { Branch, BranchSchema } from '../../branches/schemas/branch.schema';
import {
  BranchManagerAssignment,
  BranchManagerAssignmentSchema,
} from '../../branches/schemas/branch-manager-assignment.schema';
import { DepartmentsService } from '../../identity/departments.service';
import { RefreshTokenService } from '../../identity/refresh-token.service';
import { Department, DepartmentSchema } from '../../identity/schemas/department.schema';
import { RefreshToken, RefreshTokenSchema } from '../../identity/schemas/refresh-token.schema';
import { Staff, StaffDocument, StaffSchema } from '../../identity/schemas/staff.schema';
import { Unit, UnitSchema } from '../../identity/schemas/unit.schema';
import { StaffService } from '../../identity/staff.service';
import { UnitsService } from '../../identity/units.service';
import { LeaveApplicationService } from '../leave-application.service';
import { LeaveBalanceService } from '../leave-balance.service';
import { LeaveTypeService } from '../leave-type.service';
import { SalaryService } from '../salary.service';
import {
  LeaveApplication,
  LeaveApplicationDocument,
  LeaveApplicationSchema,
} from '../schemas/leave-application.schema';
import {
  LeaveBalance,
  LeaveBalanceDocument,
  LeaveBalanceSchema,
} from '../schemas/leave-balance.schema';
import { LeaveType, LeaveTypeDocument, LeaveTypeSchema } from '../schemas/leave-type.schema';
import {
  SalaryRecord,
  SalaryRecordDocument,
  SalaryRecordSchema,
} from '../schemas/salary-record.schema';

export interface HrTestContext {
  moduleRef: TestingModule;
  mongo: InMemoryMongo;

  staffService: StaffService;
  branchManagerAssignmentService: BranchManagerAssignmentService;
  workflowEngineService: WorkflowEngineService;
  leaveTypeService: LeaveTypeService;
  leaveBalanceService: LeaveBalanceService;
  leaveApplicationService: LeaveApplicationService;
  salaryService: SalaryService;

  staffModel: Model<StaffDocument>;
  branchModel: Model<Branch>;
  leaveTypeModel: Model<LeaveTypeDocument>;
  leaveBalanceModel: Model<LeaveBalanceDocument>;
  leaveApplicationModel: Model<LeaveApplicationDocument>;
  salaryRecordModel: Model<SalaryRecordDocument>;
  workflowRequestModel: Model<WorkflowRequestDocument>;
}

export async function createHrTestContext(): Promise<HrTestContext> {
  process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  __resetPiiEncryptionKeyCache();

  const mongo = new InMemoryMongo();
  await mongo.start();

  const moduleRef = await Test.createTestingModule({
    imports: [
      MongooseModule.forRoot(mongo.getUri()),
      MongooseModule.forFeature([
        { name: Department.name, schema: DepartmentSchema },
        { name: Unit.name, schema: UnitSchema },
        { name: Staff.name, schema: StaffSchema },
        { name: RefreshToken.name, schema: RefreshTokenSchema },
        { name: Branch.name, schema: BranchSchema },
        { name: WorkflowChainConfig.name, schema: WorkflowChainConfigSchema },
        { name: WorkflowRequest.name, schema: WorkflowRequestSchema },
        { name: BvnCallLog.name, schema: BvnCallLogSchema },
        { name: BranchManagerAssignment.name, schema: BranchManagerAssignmentSchema },
        { name: LeaveType.name, schema: LeaveTypeSchema },
        { name: LeaveBalance.name, schema: LeaveBalanceSchema },
        { name: LeaveApplication.name, schema: LeaveApplicationSchema },
        { name: SalaryRecord.name, schema: SalaryRecordSchema },
      ]),
      AuditModule,
      EventEmitterModule.forRoot(),
    ],
    providers: [
      DepartmentsService,
      UnitsService,
      StaffService,
      RefreshTokenService,
      WorkflowEngineService,
      EncryptionService,
      BvnCallLogService,
      MockBvnVerificationAdapter,
      { provide: BVN_VERIFICATION_ADAPTER, useExisting: MockBvnVerificationAdapter },
      BranchManagerAssignmentService,
      LeaveTypeService,
      LeaveBalanceService,
      LeaveApplicationService,
      SalaryService,
    ],
  }).compile();

  await moduleRef.init(); // runs LeaveApplicationService/SalaryService.onModuleInit (chain registration) + @OnEvent discovery

  return {
    moduleRef,
    mongo,
    staffService: moduleRef.get(StaffService),
    branchManagerAssignmentService: moduleRef.get(BranchManagerAssignmentService),
    workflowEngineService: moduleRef.get(WorkflowEngineService),
    leaveTypeService: moduleRef.get(LeaveTypeService),
    leaveBalanceService: moduleRef.get(LeaveBalanceService),
    leaveApplicationService: moduleRef.get(LeaveApplicationService),
    salaryService: moduleRef.get(SalaryService),
    staffModel: moduleRef.get(getModelToken(Staff.name)),
    branchModel: moduleRef.get(getModelToken(Branch.name)),
    leaveTypeModel: moduleRef.get(getModelToken(LeaveType.name)),
    leaveBalanceModel: moduleRef.get(getModelToken(LeaveBalance.name)),
    leaveApplicationModel: moduleRef.get(getModelToken(LeaveApplication.name)),
    salaryRecordModel: moduleRef.get(getModelToken(SalaryRecord.name)),
    workflowRequestModel: moduleRef.get(getModelToken(WorkflowRequest.name)),
  };
}

export async function teardownHrTestContext(ctx: HrTestContext): Promise<void> {
  await ctx.moduleRef.close();
  await ctx.mongo.stop();
}

export async function clearHrTestState(ctx: HrTestContext): Promise<void> {
  await ctx.leaveApplicationModel.deleteMany({}).exec();
  await ctx.leaveBalanceModel.deleteMany({}).exec();
  await ctx.salaryRecordModel.deleteMany({}).exec();
  await ctx.workflowRequestModel.deleteMany({}).exec();
  await ctx.staffModel.deleteMany({}).exec();
  await ctx.branchModel.deleteMany({}).exec();
  // LeaveType intentionally preserved — tests that need a fresh one create their own with a unique name.
}

export async function createBranch(ctx: HrTestContext): Promise<string> {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const branch = await ctx.branchModel.create({
    name: `Branch-${suffix}`,
    code: `BR${suffix}`,
    address: '1 Test Street',
    active: true,
  });
  return branch._id.toString();
}

export async function createStaffMember(
  ctx: HrTestContext,
  branchId: string,
  overrides: Partial<{ role: StaffRole; status: StaffStatus }> = {},
): Promise<StaffDocument> {
  return ctx.staffModel.create({
    firstName: 'Test',
    lastName: 'Staff',
    email: `staff.${Date.now()}.${Math.random()}@example.com`,
    phoneNumber: `080${Math.floor(Math.random() * 1e8)}`,
    passwordHash: 'hashed',
    role: overrides.role ?? StaffRole.MARKETER,
    departmentId: new Types.ObjectId(),
    unitId: new Types.ObjectId(),
    branchId: new Types.ObjectId(branchId),
    moduleAccess: [ModuleName.HR],
    status: overrides.status ?? StaffStatus.ACTIVE,
  });
}

export async function createLeaveType(
  ctx: HrTestContext,
  overrides: Partial<{ defaultAnnualAllocationDays: number; paid: boolean }> = {},
): Promise<LeaveTypeDocument> {
  return ctx.leaveTypeModel.create({
    name: `Annual-${Date.now()}-${Math.random()}`,
    defaultAnnualAllocationDays: overrides.defaultAnnualAllocationDays ?? 20,
    paid: overrides.paid ?? true,
    active: true,
  });
}

export function reviewLeaveActor(staffId: string): ActingStaff {
  return { staffId, capabilities: [reviewCapability(WorkflowEntityType.LEAVE_APPLICATION)] };
}

export function approveLeaveActor(staffId: string): ActingStaff {
  return { staffId, capabilities: [approveCapability(WorkflowEntityType.LEAVE_APPLICATION)] };
}

export function approveSalaryActor(staffId: string): ActingStaff {
  return { staffId, capabilities: [approveCapability(WorkflowEntityType.SALARY_RECORD)] };
}

export async function actOnWorkflow(
  ctx: HrTestContext,
  workflowRequestId: string,
  actor: ActingStaff,
  action: WorkflowStepAction = WorkflowStepAction.APPROVED,
): Promise<void> {
  await ctx.workflowEngineService.act({ workflowRequestId, actor, action });
}
