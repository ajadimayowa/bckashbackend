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
import { BranchStaffRoleAssignmentService } from './branch-staff-role-assignment.service';
import { Branch, BranchDocument, BranchSchema } from './schemas/branch.schema';
import {
  BranchStaffRoleAssignment,
  BranchStaffRoleAssignmentDocument,
  BranchStaffRoleAssignmentSchema,
} from './schemas/branch-staff-role-assignment.schema';

describe('BranchStaffRoleAssignmentService', () => {
  const mongo = new InMemoryMongo();
  const INITIATOR_ID = new Types.ObjectId().toString();
  const APPROVER_ID = new Types.ObjectId().toString();

  const APPROVE_ACTOR: ActingStaff = {
    staffId: APPROVER_ID,
    capabilities: [approveCapability(WorkflowEntityType.BRANCH_ROLE_ASSIGNMENT)],
  };

  let moduleRef: TestingModule;
  let service: BranchStaffRoleAssignmentService;
  let workflowEngineService: WorkflowEngineService;
  let staffModel: Model<StaffDocument>;
  let branchModel: Model<BranchDocument>;
  let assignmentModel: Model<BranchStaffRoleAssignmentDocument>;

  beforeAll(async () => {
    await mongo.start();

    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri()),
        MongooseModule.forFeature([
          { name: BranchStaffRoleAssignment.name, schema: BranchStaffRoleAssignmentSchema },
          { name: Staff.name, schema: StaffSchema },
          { name: Branch.name, schema: BranchSchema },
          { name: WorkflowChainConfig.name, schema: WorkflowChainConfigSchema },
          { name: WorkflowRequest.name, schema: WorkflowRequestSchema },
        ]),
        AuditModule,
        EventEmitterModule.forRoot(),
      ],
      providers: [BranchStaffRoleAssignmentService, WorkflowEngineService],
    }).compile();

    service = moduleRef.get(BranchStaffRoleAssignmentService);
    workflowEngineService = moduleRef.get(WorkflowEngineService);
    staffModel = moduleRef.get(getModelToken(Staff.name));
    branchModel = moduleRef.get(getModelToken(Branch.name));
    assignmentModel = moduleRef.get(getModelToken(BranchStaffRoleAssignment.name));

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
      role: overrides.role ?? StaffRole.ADMIN,
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
    staffId: string,
    branchIds: string[],
    role: StaffRole.ADMIN | StaffRole.APPROVER = StaffRole.ADMIN,
    comments?: string,
  ): Promise<void> {
    const request = await service.initiateAssignment(staffId, branchIds, role, comments, INITIATOR_ID);
    await approve(request._id.toString());
  }

  describe('initiateAssignment / approval workflow', () => {
    it('rejects proposing a staff member whose role does not match the assignment role', async () => {
      const marketer = await createStaff({ role: StaffRole.MARKETER });
      const branch = await createBranch();

      await expect(
        service.initiateAssignment(
          marketer._id.toString(),
          [branch._id.toString()],
          StaffRole.ADMIN,
          undefined,
          INITIATOR_ID,
        ),
      ).rejects.toThrow(/not ADMIN/);
    });

    it('rejects proposing a DISABLED staff member', async () => {
      const admin = await createStaff({ status: StaffStatus.DISABLED });
      const branch = await createBranch();

      await expect(
        service.initiateAssignment(
          admin._id.toString(),
          [branch._id.toString()],
          StaffRole.ADMIN,
          undefined,
          INITIATOR_ID,
        ),
      ).rejects.toThrow(/not ACTIVE/);
    });

    it('rejects a batch containing a branchId that does not exist', async () => {
      const admin = await createStaff();
      const branch = await createBranch();
      const missingBranchId = new Types.ObjectId().toString();

      await expect(
        service.initiateAssignment(
          admin._id.toString(),
          [branch._id.toString(), missingBranchId],
          StaffRole.ADMIN,
          undefined,
          INITIATOR_ID,
        ),
      ).rejects.toThrow(/do not exist/);
    });

    it('proposing creates nothing until approved', async () => {
      const admin = await createStaff();
      const branch = await createBranch();

      const request = await service.initiateAssignment(
        admin._id.toString(),
        [branch._id.toString()],
        StaffRole.ADMIN,
        undefined,
        INITIATOR_ID,
      );

      expect(request.status).toBe('PENDING_APPROVAL');
      expect(await service.getBranchesForStaff(admin._id.toString())).toHaveLength(0);
    });

    it('the maker cannot approve their own proposal', async () => {
      const admin = await createStaff();
      const branch = await createBranch();

      const request = await service.initiateAssignment(
        admin._id.toString(),
        [branch._id.toString()],
        StaffRole.ADMIN,
        undefined,
        INITIATOR_ID,
      );

      await expect(
        workflowEngineService.act({
          workflowRequestId: request._id.toString(),
          actor: { staffId: INITIATOR_ID, capabilities: [approveCapability(WorkflowEntityType.BRANCH_ROLE_ASSIGNMENT)] },
          action: WorkflowStepAction.APPROVED,
        }),
      ).rejects.toThrow(/cannot act on their own request/);
    });

    it('on approval, creates one active row per branchId in the batch, all sharing assignedBy/approvedBy/comments', async () => {
      const admin = await createStaff();
      const branchA = await createBranch();
      const branchB = await createBranch();
      const branchC = await createBranch();

      await assignAndApprove(
        admin._id.toString(),
        [branchA._id.toString(), branchB._id.toString(), branchC._id.toString()],
        StaffRole.ADMIN,
        '  covering the western region  ',
      );

      const rows = await service.getBranchesForStaff(admin._id.toString());
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.staffId.toString()).toBe(admin._id.toString());
        expect(row.role).toBe(StaffRole.ADMIN);
        expect(row.assignedBy.toString()).toBe(INITIATOR_ID);
        expect(row.approvedBy.toString()).toBe(APPROVER_ID);
        expect(row.comments).toBe('covering the western region');
        expect(row.endDate).toBeNull();
      }
    });

    it('re-validates eligibility at approval time — disabling the staff mid-flight fails the whole batch', async () => {
      const admin = await createStaff();
      const branchA = await createBranch();
      const branchB = await createBranch();

      const request = await service.initiateAssignment(
        admin._id.toString(),
        [branchA._id.toString(), branchB._id.toString()],
        StaffRole.ADMIN,
        undefined,
        INITIATOR_ID,
      );

      await staffModel.updateOne({ _id: admin._id }, { $set: { status: StaffStatus.DISABLED } }).exec();

      await expect(approve(request._id.toString())).rejects.toThrow(/not ACTIVE/);
      expect(await service.getBranchesForStaff(admin._id.toString())).toHaveLength(0);
    });

    it('approving a batch that includes an already-covered branch is idempotent — no throw, no duplicate row', async () => {
      const admin = await createStaff();
      const branch = await createBranch();

      await assignAndApprove(admin._id.toString(), [branch._id.toString()], StaffRole.ADMIN);
      await assignAndApprove(admin._id.toString(), [branch._id.toString()], StaffRole.ADMIN);

      const rows = await service.getBranchesForStaff(admin._id.toString());
      expect(rows).toHaveLength(1);
    });

    it('two different staff can both be actively assigned to the same branch at once (many-to-many)', async () => {
      const branch = await createBranch();
      const adminA = await createStaff();
      const adminB = await createStaff();

      await assignAndApprove(adminA._id.toString(), [branch._id.toString()], StaffRole.ADMIN);
      await assignAndApprove(adminB._id.toString(), [branch._id.toString()], StaffRole.ADMIN);

      const staffForBranch = await service.getStaffForBranch(branch._id.toString());
      const staffIds = staffForBranch.map((row) => row.staffId.toString()).sort();
      expect(staffIds).toEqual([adminA._id.toString(), adminB._id.toString()].sort());
    });

    it('one staff can be actively assigned to multiple branches at once', async () => {
      const admin = await createStaff();
      const branchA = await createBranch();
      const branchB = await createBranch();

      await assignAndApprove(admin._id.toString(), [branchA._id.toString(), branchB._id.toString()], StaffRole.ADMIN);

      const rows = await service.getBranchesForStaff(admin._id.toString());
      expect(rows.map((r) => r.branchId.toString()).sort()).toEqual(
        [branchA._id.toString(), branchB._id.toString()].sort(),
      );
    });

    it('supports APPROVER role assignments the same way as ADMIN', async () => {
      const approver = await createStaff({ role: StaffRole.APPROVER });
      const branch = await createBranch();

      await assignAndApprove(approver._id.toString(), [branch._id.toString()], StaffRole.APPROVER);

      const rows = await service.getStaffForBranch(branch._id.toString(), StaffRole.APPROVER);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.staffId.toString()).toBe(approver._id.toString());
    });
  });

  describe('getBranchesForStaff / getStaffForBranch', () => {
    it('exclude revoked rows and support the optional role filter', async () => {
      const admin = await createStaff({ role: StaffRole.ADMIN });
      const branchA = await createBranch();
      const branchB = await createBranch();

      await assignAndApprove(admin._id.toString(), [branchA._id.toString(), branchB._id.toString()], StaffRole.ADMIN);
      await service.revokeAssignment(admin._id.toString(), branchA._id.toString(), StaffRole.ADMIN, APPROVER_ID);

      const remaining = await service.getBranchesForStaff(admin._id.toString());
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.branchId.toString()).toBe(branchB._id.toString());

      expect(await service.getStaffForBranch(branchA._id.toString())).toHaveLength(0);
      expect(await service.getStaffForBranch(branchB._id.toString(), StaffRole.ADMIN)).toHaveLength(1);
      expect(await service.getStaffForBranch(branchB._id.toString(), StaffRole.APPROVER)).toHaveLength(0);
    });
  });

  describe('revokeAssignment', () => {
    it('closes only the targeted (staffId, branchId, role) row and leaves other branch assignments untouched', async () => {
      const admin = await createStaff();
      const branchA = await createBranch();
      const branchB = await createBranch();

      await assignAndApprove(admin._id.toString(), [branchA._id.toString(), branchB._id.toString()], StaffRole.ADMIN);
      await service.revokeAssignment(admin._id.toString(), branchA._id.toString(), StaffRole.ADMIN, APPROVER_ID, 'reassigned');

      const rows = await service.getBranchesForStaff(admin._id.toString());
      expect(rows).toHaveLength(1);
      expect(rows[0]?.branchId.toString()).toBe(branchB._id.toString());

      const closed = await assignmentModel.findOne({ staffId: admin._id, branchId: branchA._id }).exec();
      expect(closed?.endDate).not.toBeNull();
    });

    it('throws when revoking a branch the staff is not currently assigned to', async () => {
      const admin = await createStaff();
      const branch = await createBranch();

      await expect(
        service.revokeAssignment(admin._id.toString(), branch._id.toString(), StaffRole.ADMIN, APPROVER_ID),
      ).rejects.toThrow(/no active/);
    });
  });

  describe('partial unique index', () => {
    it('prevents two simultaneous active rows for the same (staff, branch, role) via a direct insert', async () => {
      const staffId = new Types.ObjectId();
      const branchId = new Types.ObjectId();

      await assignmentModel.create({
        staffId,
        branchId,
        role: StaffRole.ADMIN,
        startDate: new Date(),
        endDate: null,
        assignedBy: staffId,
        approvedBy: staffId,
      });

      await expect(
        assignmentModel.create({
          staffId,
          branchId,
          role: StaffRole.ADMIN,
          startDate: new Date(),
          endDate: null,
          assignedBy: staffId,
          approvedBy: staffId,
        }),
      ).rejects.toThrow(/duplicate key/);
    });

    it('allows the same staff to hold active ADMIN and APPROVER rows for the same branch at once', async () => {
      const staffId = new Types.ObjectId();
      const branchId = new Types.ObjectId();

      await assignmentModel.create({
        staffId,
        branchId,
        role: StaffRole.ADMIN,
        startDate: new Date(),
        endDate: null,
        assignedBy: staffId,
        approvedBy: staffId,
      });

      await expect(
        assignmentModel.create({
          staffId,
          branchId,
          role: StaffRole.APPROVER,
          startDate: new Date(),
          endDate: null,
          assignedBy: staffId,
          approvedBy: staffId,
        }),
      ).resolves.toBeDefined();
    });
  });
});
