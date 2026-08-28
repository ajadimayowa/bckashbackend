import { EventEmitterModule } from '@nestjs/event-emitter';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model, Types } from 'mongoose';

import { StaffRole, StaffStatus } from '../../common/enums/identity.enums';
import { WorkflowEntityType, WorkflowStepAction } from '../../common/enums/workflow.enums';
import { AuditModule } from '../../platform/audit/audit.module';
import { approveCapability } from '../../platform/rbac/constants/capabilities';
import { ActingStaff } from '../../platform/workflow-engine/interfaces/workflow-engine.interfaces';
import {
  WorkflowChainConfig,
  WorkflowChainConfigSchema,
} from '../../platform/workflow-engine/schemas/workflow-chain-config.schema';
import {
  WorkflowRequest,
  WorkflowRequestSchema,
} from '../../platform/workflow-engine/schemas/workflow-request.schema';
import { WorkflowEngineService } from '../../platform/workflow-engine/workflow-engine.service';
import { InMemoryMongo } from '../../test-utils/in-memory-mongo';
import { Staff, StaffDocument, StaffSchema } from '../identity/schemas/staff.schema';
import { BranchManagerAssignmentService } from './branch-manager-assignment.service';
import { Branch, BranchDocument, BranchSchema } from './schemas/branch.schema';
import {
  BranchManagerAssignment,
  BranchManagerAssignmentDocument,
  BranchManagerAssignmentSchema,
} from './schemas/branch-manager-assignment.schema';

describe('BranchManagerAssignmentService', () => {
  const mongo = new InMemoryMongo();
  const INITIATOR_ID = new Types.ObjectId().toString();
  const APPROVER_ID = new Types.ObjectId().toString();

  const APPROVE_ACTOR: ActingStaff = {
    staffId: APPROVER_ID,
    capabilities: [approveCapability(WorkflowEntityType.BRANCH_MANAGER_ASSIGNMENT)],
  };

  let moduleRef: TestingModule;
  let service: BranchManagerAssignmentService;
  let workflowEngineService: WorkflowEngineService;
  let staffModel: Model<StaffDocument>;
  let branchModel: Model<BranchDocument>;
  let assignmentModel: Model<BranchManagerAssignmentDocument>;

  beforeAll(async () => {
    await mongo.start();

    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri()),
        MongooseModule.forFeature([
          { name: BranchManagerAssignment.name, schema: BranchManagerAssignmentSchema },
          { name: Staff.name, schema: StaffSchema },
          { name: Branch.name, schema: BranchSchema },
          { name: WorkflowChainConfig.name, schema: WorkflowChainConfigSchema },
          { name: WorkflowRequest.name, schema: WorkflowRequestSchema },
        ]),
        AuditModule,
        EventEmitterModule.forRoot(),
      ],
      providers: [BranchManagerAssignmentService, WorkflowEngineService],
    }).compile();

    service = moduleRef.get(BranchManagerAssignmentService);
    workflowEngineService = moduleRef.get(WorkflowEngineService);
    staffModel = moduleRef.get(getModelToken(Staff.name));
    branchModel = moduleRef.get(getModelToken(Branch.name));
    assignmentModel = moduleRef.get(getModelToken(BranchManagerAssignment.name));

    await moduleRef.init();
  }, 60_000);

  afterEach(async () => {
    const collectionsToKeep = new Set(['workflow_chain_configs']);
    const collections = await assignmentModel.db.db!.collections();
    await Promise.all(
      collections.filter((c) => !collectionsToKeep.has(c.collectionName)).map((c) => c.deleteMany({})),
    );
  });

  afterAll(async () => {
    await moduleRef.close();
    await mongo.stop();
  });

  async function createStaff(overrides: Partial<{ role: StaffRole; status: StaffStatus }> = {}) {
    return staffModel.create({
      firstName: 'A',
      lastName: 'B',
      email: `staff.${Date.now()}.${Math.random()}@example.com`,
      phoneNumber: `080${Math.floor(Math.random() * 1e8)}`,
      passwordHash: 'hashed',
      role: overrides.role ?? StaffRole.MANAGER,
      departmentId: new Types.ObjectId(),
      unitId: new Types.ObjectId(),
      branchId: new Types.ObjectId(),
      moduleAccess: [],
      status: overrides.status ?? StaffStatus.ACTIVE,
    });
  }

  async function createBranch() {
    return branchModel.create({
      name: 'Ikeja Branch',
      code: `BR${Math.floor(Math.random() * 1e8)}`,
      address: '1 Allen Avenue',
      active: true,
    });
  }

  async function approve(requestId: string, actor: ActingStaff = APPROVE_ACTOR): Promise<void> {
    await workflowEngineService.act({ workflowRequestId: requestId, actor, action: WorkflowStepAction.APPROVED });
  }

  /** Proposes then immediately approves — the common-path helper most tests below want. */
  async function assignAndApprove(
    branchId: string,
    staffId: string,
    comments?: string,
  ): Promise<BranchManagerAssignmentDocument> {
    const request = await service.initiateAssignment(branchId, staffId, comments, INITIATOR_ID);
    await approve(request._id.toString());
    const current = await service.getCurrentManager(branchId);
    if (!current) {
      throw new Error('expected an active assignment after approval');
    }
    return current;
  }

  describe('initiateAssignment / approval workflow', () => {
    it('rejects proposing a staff member who is not role MANAGER', async () => {
      const marketer = await createStaff({ role: StaffRole.MARKETER });
      const branch = await createBranch();

      await expect(
        service.initiateAssignment(branch._id.toString(), marketer._id.toString(), undefined, INITIATOR_ID),
      ).rejects.toThrow(/not MANAGER/);
    });

    it('rejects proposing a MANAGER who is not ACTIVE', async () => {
      const manager = await createStaff({ role: StaffRole.MANAGER, status: StaffStatus.DISABLED });
      const branch = await createBranch();

      await expect(
        service.initiateAssignment(branch._id.toString(), manager._id.toString(), undefined, INITIATOR_ID),
      ).rejects.toThrow(/not ACTIVE/);
    });

    it('rejects proposing for a branch that does not exist', async () => {
      const manager = await createStaff();
      const branchId = new Types.ObjectId().toString();

      await expect(
        service.initiateAssignment(branchId, manager._id.toString(), undefined, INITIATOR_ID),
      ).rejects.toThrow(/does not exist/);
    });

    it('proposing an assignment creates nothing until approved', async () => {
      const manager = await createStaff();
      const branch = await createBranch();

      const request = await service.initiateAssignment(
        branch._id.toString(),
        manager._id.toString(),
        undefined,
        INITIATOR_ID,
      );
      expect(request.status).toBe('PENDING_APPROVAL');
      expect(await service.getCurrentManager(branch._id.toString())).toBeNull();
    });

    it('the maker cannot approve their own proposal', async () => {
      const manager = await createStaff();
      const branch = await createBranch();

      const request = await service.initiateAssignment(
        branch._id.toString(),
        manager._id.toString(),
        undefined,
        INITIATOR_ID,
      );

      await expect(
        workflowEngineService.act({
          workflowRequestId: request._id.toString(),
          actor: { staffId: INITIATOR_ID, capabilities: [approveCapability(WorkflowEntityType.BRANCH_MANAGER_ASSIGNMENT)] },
          action: WorkflowStepAction.APPROVED,
        }),
      ).rejects.toThrow(/cannot act on their own request/);
    });

    it('on approval, activates the assignment and stamps assignedBy/approvedBy/comments', async () => {
      const manager = await createStaff();
      const branch = await createBranch();

      const request = await service.initiateAssignment(
        branch._id.toString(),
        manager._id.toString(),
        '  promoted from acting manager  ',
        INITIATOR_ID,
      );
      await approve(request._id.toString());

      const current = await service.getCurrentManager(branch._id.toString());
      expect(current).not.toBeNull();
      expect(current?.staffId.toString()).toBe(manager._id.toString());
      expect(current?.assignedBy.toString()).toBe(INITIATOR_ID);
      expect(current?.approvedBy.toString()).toBe(APPROVER_ID);
      expect(current?.comments).toBe('promoted from acting manager');
    });

    it('a rejected proposal never creates an assignment', async () => {
      const manager = await createStaff();
      const branch = await createBranch();

      const request = await service.initiateAssignment(
        branch._id.toString(),
        manager._id.toString(),
        undefined,
        INITIATOR_ID,
      );
      await workflowEngineService.act({
        workflowRequestId: request._id.toString(),
        actor: APPROVE_ACTOR,
        action: WorkflowStepAction.REJECTED,
        comment: 'wrong candidate',
      });

      expect(await service.getCurrentManager(branch._id.toString())).toBeNull();
    });

    it('re-validates eligibility at approval time — a staff member disabled after proposal fails approval', async () => {
      const manager = await createStaff();
      const branch = await createBranch();

      const request = await service.initiateAssignment(
        branch._id.toString(),
        manager._id.toString(),
        undefined,
        INITIATOR_ID,
      );

      await staffModel.updateOne({ _id: manager._id }, { $set: { status: StaffStatus.DISABLED } }).exec();

      await expect(approve(request._id.toString())).rejects.toThrow(/not ACTIVE/);
      expect(await service.getCurrentManager(branch._id.toString())).toBeNull();
    });

    it('closes the prior active assignment when reassigning', async () => {
      const branch = await createBranch();
      const managerA = await createStaff();
      const managerB = await createStaff();

      const first = await assignAndApprove(branch._id.toString(), managerA._id.toString());
      expect(first.endDate).toBeNull();

      const second = await assignAndApprove(branch._id.toString(), managerB._id.toString());

      const reloadedFirst = await assignmentModel.findById(first._id).exec();
      expect(reloadedFirst?.endDate).not.toBeNull();
      expect(second.endDate).toBeNull();
      expect(second.staffId.toString()).toBe(managerB._id.toString());
    });
  });

  describe('partial unique index', () => {
    it('prevents two simultaneous active assignments for one branch via a direct insert', async () => {
      const branchId = new Types.ObjectId();
      const managerA = await createStaff();
      const managerB = await createStaff();

      await assignmentModel.create({
        branchId,
        staffId: managerA._id,
        startDate: new Date(),
        endDate: null,
        assignedBy: managerA._id,
        approvedBy: managerA._id,
      });

      // Direct model-level attempt — bypasses the service entirely, proving
      // the DB constraint itself (not just service-level logic) is what
      // guarantees at most one active assignment per branch.
      await expect(
        assignmentModel.create({
          branchId,
          staffId: managerB._id,
          startDate: new Date(),
          endDate: null,
          assignedBy: managerA._id,
          approvedBy: managerA._id,
        }),
      ).rejects.toThrow(/duplicate key/);
    });

    it('allows two *closed* assignments for the same branch (endDate is not null)', async () => {
      const branchId = new Types.ObjectId();
      const managerA = await createStaff();
      const managerB = await createStaff();

      await assignmentModel.create({
        branchId,
        staffId: managerA._id,
        startDate: new Date('2025-01-01'),
        endDate: new Date('2025-06-01'),
        assignedBy: managerA._id,
        approvedBy: managerA._id,
      });

      await expect(
        assignmentModel.create({
          branchId,
          staffId: managerB._id,
          startDate: new Date('2025-06-01'),
          endDate: new Date('2025-12-01'),
          assignedBy: managerA._id,
          approvedBy: managerA._id,
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('getCurrentManager', () => {
    it('returns null for a branch with no assignment history', async () => {
      const branchId = new Types.ObjectId().toString();

      const current = await service.getCurrentManager(branchId);

      expect(current).toBeNull();
    });

    it('returns the correct staff member after a reassignment', async () => {
      const branch = await createBranch();
      const managerA = await createStaff();
      const managerB = await createStaff();

      await assignAndApprove(branch._id.toString(), managerA._id.toString());
      let current = await service.getCurrentManager(branch._id.toString());
      expect(current?.staffId.toString()).toBe(managerA._id.toString());

      await assignAndApprove(branch._id.toString(), managerB._id.toString());
      current = await service.getCurrentManager(branch._id.toString());
      expect(current?.staffId.toString()).toBe(managerB._id.toString());
    });
  });

  describe('getHistory', () => {
    it('returns the full assignment history for a branch, newest (current) first', async () => {
      const branch = await createBranch();
      const managerA = await createStaff();
      const managerB = await createStaff();

      await assignAndApprove(branch._id.toString(), managerA._id.toString());
      await assignAndApprove(branch._id.toString(), managerB._id.toString());

      const history = await service.getHistory(branch._id.toString());

      expect(history).toHaveLength(2);
      expect(history[0]?.staffId.toString()).toBe(managerB._id.toString());
      expect(history[1]?.staffId.toString()).toBe(managerA._id.toString());
    });
  });
});
