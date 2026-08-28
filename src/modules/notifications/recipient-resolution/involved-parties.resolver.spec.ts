import { randomBytes } from 'node:crypto';

import { EventEmitterModule } from '@nestjs/event-emitter';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model, Types } from 'mongoose';

import { __resetPiiEncryptionKeyCache } from '../../../common/crypto/pii-encryption';
import { ModuleName, StaffRole, StaffStatus } from '../../../common/enums/identity.enums';
import { WorkflowEntityType, WorkflowStatus } from '../../../common/enums/workflow.enums';
import { AuditModule } from '../../../platform/audit/audit.module';
import { EncryptionService } from '../../../platform/encryption/encryption.service';
import { BvnCallLogService } from '../../../platform/integrations/bvn/bvn-call-log.service';
import { BVN_VERIFICATION_ADAPTER } from '../../../platform/integrations/bvn/interfaces/bvn-verification-adapter.interface';
import { MockBvnVerificationAdapter } from '../../../platform/integrations/bvn/mock-bvn-verification.adapter';
import {
  BvnCallLog,
  BvnCallLogSchema,
} from '../../../platform/integrations/bvn/schemas/bvn-call-log.schema';
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
import { Branch, BranchSchema } from '../../branches/schemas/branch.schema';
import {
  BranchManagerAssignment,
  BranchManagerAssignmentDocument,
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
import { InvolvedPartiesResolver } from './involved-parties.resolver';

describe('InvolvedPartiesResolver', () => {
  const mongo = new InMemoryMongo();
  // A stand-in for an admin actor who isn't otherwise a Staff fixture in a
  // given test — must be a valid ObjectId hex string, not an arbitrary
  // label, since assignedBy is a real ObjectId-typed schema path (see
  // branch-manager-assignment.schema.ts).
  const ADMIN_ACTOR_ID = new Types.ObjectId().toString();
  let moduleRef: TestingModule;
  let resolver: InvolvedPartiesResolver;
  let staffModel: Model<StaffDocument>;
  let branchManagerAssignmentModel: Model<BranchManagerAssignmentDocument>;
  let workflowRequestModel: Model<WorkflowRequestDocument>;
  let branchId: string;

  beforeAll(async () => {
    process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    __resetPiiEncryptionKeyCache();

    await mongo.start();

    moduleRef = await Test.createTestingModule({
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
        InvolvedPartiesResolver,
      ],
    }).compile();

    resolver = moduleRef.get(InvolvedPartiesResolver);
    staffModel = moduleRef.get(getModelToken(Staff.name));
    branchManagerAssignmentModel = moduleRef.get(getModelToken(BranchManagerAssignment.name));
    workflowRequestModel = moduleRef.get(getModelToken(WorkflowRequest.name));

    await moduleRef.init();
  }, 60_000);

  beforeEach(() => {
    branchId = new Types.ObjectId().toString();
  });

  afterEach(async () => {
    await mongo.clearAllCollections();
  });

  afterAll(async () => {
    await moduleRef.close();
    await mongo.stop();
  });

  async function createStaff(role: StaffRole, overrides: Partial<{ status: StaffStatus }> = {}) {
    return staffModel.create({
      firstName: 'A',
      lastName: 'B',
      email: `staff.${Date.now()}.${Math.random()}@example.com`,
      phoneNumber: `080${Math.floor(Math.random() * 1e8)}`,
      passwordHash: 'hashed',
      role,
      departmentId: new Types.ObjectId(),
      unitId: new Types.ObjectId(),
      branchId: new Types.ObjectId(branchId),
      moduleAccess: [ModuleName.LOANS],
      status: overrides.status ?? StaffStatus.ACTIVE,
    });
  }

  async function createWorkflowRequestWithActedSteps(actedByIds: (string | null)[]) {
    return workflowRequestModel.create({
      entityType: WorkflowEntityType.LOAN,
      entityId: new Types.ObjectId().toString(),
      action: 'APPROVE',
      status: WorkflowStatus.APPROVED,
      chainConfigRef: 'LOAN:APPROVE',
      steps: actedByIds.map((actedBy, index) => ({
        order: index,
        requiredCapability: 'workflow:approve:LOAN',
        actedBy,
        action: actedBy ? 'APPROVED' : null,
        comment: null,
        actedAt: actedBy ? new Date() : null,
      })),
      currentStepIndex: actedByIds.length,
      payloadHistory: [{ payload: {}, submittedBy: 'system', submittedAt: new Date() }],
      initiatedBy: new Types.ObjectId().toString(),
      branchId,
    });
  }

  it('includes the initiator and the current branch manager', async () => {
    const marketer = await createStaff(StaffRole.MARKETER);
    const manager = await createStaff(StaffRole.MANAGER);
    // Fixture setup only — inserted directly rather than through
    // BranchManagerAssignmentService (now a full maker-checker workflow,
    // see its own doc comment) this spec has no interest in exercising, and
    // whose branch-existence check `branchId` here (a bare foreign key, not
    // a real Branch document) wouldn't satisfy.
    await branchManagerAssignmentModel.create({
      branchId: new Types.ObjectId(branchId),
      staffId: manager._id,
      startDate: new Date(),
      endDate: null,
      assignedBy: new Types.ObjectId(ADMIN_ACTOR_ID),
      approvedBy: new Types.ObjectId(ADMIN_ACTOR_ID),
    });
    const admin = await createStaff(StaffRole.ADMIN);
    const request = await createWorkflowRequestWithActedSteps([admin._id.toString()]);

    const recipients = await resolver.resolveInvolvedParties({
      branchId,
      initiatedBy: marketer._id.toString(),
      relatedWorkflowRequestId: request._id.toString(),
    });

    expect(recipients).toEqual(
      expect.arrayContaining([
        marketer._id.toString(),
        manager._id.toString(),
        admin._id.toString(),
      ]),
    );
  });

  it('includes every Admin/SuperAdmin who acted on the related workflow request', async () => {
    const marketer = await createStaff(StaffRole.MARKETER);
    const admin1 = await createStaff(StaffRole.ADMIN);
    const admin2 = await createStaff(StaffRole.SUPERADMIN);
    // A non-admin acted too (e.g. a MANAGER review step) — must NOT be included via this path.
    const manager = await createStaff(StaffRole.MANAGER);
    const request = await createWorkflowRequestWithActedSteps([
      manager._id.toString(),
      admin1._id.toString(),
      admin2._id.toString(),
    ]);

    const recipients = await resolver.resolveInvolvedParties({
      branchId,
      initiatedBy: marketer._id.toString(),
      relatedWorkflowRequestId: request._id.toString(),
    });

    expect(recipients).toEqual(
      expect.arrayContaining([admin1._id.toString(), admin2._id.toString()]),
    );
    // The reviewing manager isn't an admin-acted-on-the-request recipient,
    // and isn't the current branch manager or initiator either.
    expect(recipients).not.toContain(manager._id.toString());
  });

  it('falls back to branch-level Admin/SuperAdmin when no admin has acted on the related request yet', async () => {
    const marketer = await createStaff(StaffRole.MARKETER);
    // No admin/superadmin has acted — only a pending (unacted) step exists.
    const request = await createWorkflowRequestWithActedSteps([null]);
    const branchAdmin = await createStaff(StaffRole.ADMIN);

    const recipients = await resolver.resolveInvolvedParties({
      branchId,
      initiatedBy: marketer._id.toString(),
      relatedWorkflowRequestId: request._id.toString(),
    });

    expect(recipients).toContain(branchAdmin._id.toString());
  });

  it('does not apply the branch-admin fallback when an admin recipient is already present (e.g. the initiator is themselves an Admin)', async () => {
    const adminInitiator = await createStaff(StaffRole.ADMIN);
    const otherBranchAdmin = await createStaff(StaffRole.ADMIN);

    const recipients = await resolver.resolveInvolvedParties({
      branchId,
      initiatedBy: adminInitiator._id.toString(),
    });

    expect(recipients).toContain(adminInitiator._id.toString());
    expect(recipients).not.toContain(otherBranchAdmin._id.toString());
  });

  it('deduplicates a staff member who occupies more than one of these roles at once', async () => {
    const managerWhoInitiated = await createStaff(StaffRole.MANAGER);
    await branchManagerAssignmentModel.create({
      branchId: new Types.ObjectId(branchId),
      staffId: managerWhoInitiated._id,
      startDate: new Date(),
      endDate: null,
      assignedBy: new Types.ObjectId(ADMIN_ACTOR_ID),
      approvedBy: new Types.ObjectId(ADMIN_ACTOR_ID),
    });
    const admin = await createStaff(StaffRole.ADMIN);

    const recipients = await resolver.resolveInvolvedParties({
      branchId,
      initiatedBy: managerWhoInitiated._id.toString(),
    });

    const occurrences = recipients.filter((id) => id === managerWhoInitiated._id.toString());
    expect(occurrences).toHaveLength(1);
    expect(recipients).toContain(admin._id.toString());
  });
});
