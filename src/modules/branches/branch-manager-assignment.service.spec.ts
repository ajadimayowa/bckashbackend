import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model, Types } from 'mongoose';

import { StaffRole, StaffStatus } from '../../common/enums/identity.enums';
import { AuditModule } from '../../platform/audit/audit.module';
import { InMemoryMongo } from '../../test-utils/in-memory-mongo';
import { Staff, StaffDocument, StaffSchema } from '../identity/schemas/staff.schema';
import { BranchManagerAssignmentService } from './branch-manager-assignment.service';
import {
  BranchManagerAssignment,
  BranchManagerAssignmentDocument,
  BranchManagerAssignmentSchema,
} from './schemas/branch-manager-assignment.schema';

describe('BranchManagerAssignmentService', () => {
  const mongo = new InMemoryMongo();
  let moduleRef: TestingModule;
  let service: BranchManagerAssignmentService;
  let staffModel: Model<StaffDocument>;
  let assignmentModel: Model<BranchManagerAssignmentDocument>;

  beforeAll(async () => {
    await mongo.start();

    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri()),
        MongooseModule.forFeature([
          { name: BranchManagerAssignment.name, schema: BranchManagerAssignmentSchema },
          { name: Staff.name, schema: StaffSchema },
        ]),
        AuditModule,
      ],
      providers: [BranchManagerAssignmentService],
    }).compile();

    service = moduleRef.get(BranchManagerAssignmentService);
    staffModel = moduleRef.get(getModelToken(Staff.name));
    assignmentModel = moduleRef.get(getModelToken(BranchManagerAssignment.name));
  }, 60_000);

  afterEach(async () => {
    await mongo.clearAllCollections();
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

  describe('assignManager', () => {
    it('rejects a staff member who is not role MANAGER', async () => {
      const marketer = await createStaff({ role: StaffRole.MARKETER });
      const branchId = new Types.ObjectId().toString();

      await expect(
        service.assignManager(branchId, marketer._id.toString(), 'admin-1'),
      ).rejects.toThrow(/not MANAGER/);
    });

    it('rejects a MANAGER who is not ACTIVE', async () => {
      const manager = await createStaff({ role: StaffRole.MANAGER, status: StaffStatus.DISABLED });
      const branchId = new Types.ObjectId().toString();

      await expect(
        service.assignManager(branchId, manager._id.toString(), 'admin-1'),
      ).rejects.toThrow(/not ACTIVE/);
    });

    it('closes the prior active assignment when reassigning', async () => {
      const branchId = new Types.ObjectId().toString();
      const managerA = await createStaff();
      const managerB = await createStaff();

      const first = await service.assignManager(branchId, managerA._id.toString(), 'admin-1');
      expect(first.endDate).toBeNull();

      const second = await service.assignManager(branchId, managerB._id.toString(), 'admin-1');

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
      });

      await expect(
        assignmentModel.create({
          branchId,
          staffId: managerB._id,
          startDate: new Date('2025-06-01'),
          endDate: new Date('2025-12-01'),
          assignedBy: managerA._id,
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
      const branchId = new Types.ObjectId().toString();
      const managerA = await createStaff();
      const managerB = await createStaff();

      await service.assignManager(branchId, managerA._id.toString(), 'admin-1');
      let current = await service.getCurrentManager(branchId);
      expect(current?.staffId.toString()).toBe(managerA._id.toString());

      await service.assignManager(branchId, managerB._id.toString(), 'admin-1');
      current = await service.getCurrentManager(branchId);
      expect(current?.staffId.toString()).toBe(managerB._id.toString());
    });
  });

  describe('getHistory', () => {
    it('returns the full assignment history for a branch, newest first', async () => {
      const branchId = new Types.ObjectId().toString();
      const managerA = await createStaff();
      const managerB = await createStaff();

      await service.assignManager(branchId, managerA._id.toString(), 'admin-1');
      await service.assignManager(branchId, managerB._id.toString(), 'admin-1');

      const history = await service.getHistory(branchId);

      expect(history).toHaveLength(2);
      expect(history[0]?.staffId.toString()).toBe(managerB._id.toString());
      expect(history[1]?.staffId.toString()).toBe(managerA._id.toString());
    });
  });
});
