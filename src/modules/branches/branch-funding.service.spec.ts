import { ConflictException, ForbiddenException } from '@nestjs/common';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model, Types } from 'mongoose';

import { StaffRole, StaffStatus } from '../../common/enums/identity.enums';
import { BranchFundingStatus } from '../../common/enums/branch.enums';
import { AuditModule } from '../../platform/audit/audit.module';
import { InMemoryMongo } from '../../test-utils/in-memory-mongo';
import { Staff, StaffDocument, StaffSchema } from '../identity/schemas/staff.schema';
import { BranchFundBalanceService } from './branch-fund-balance.service';
import { BranchFundingService } from './branch-funding.service';
import { BranchManagerAssignmentService } from './branch-manager-assignment.service';
import {
  BranchFundBalance,
  BranchFundBalanceDocument,
  BranchFundBalanceSchema,
} from './schemas/branch-fund-balance.schema';
import {
  BranchFunding,
  BranchFundingDocument,
  BranchFundingSchema,
} from './schemas/branch-funding.schema';
import {
  BranchManagerAssignment,
  BranchManagerAssignmentSchema,
} from './schemas/branch-manager-assignment.schema';

describe('BranchFundingService', () => {
  const mongo = new InMemoryMongo();

  async function createStaff(role: StaffRole = StaffRole.MANAGER): Promise<StaffDocument> {
    const staffModel = moduleRef.get<Model<StaffDocument>>(getModelToken(Staff.name));
    return staffModel.create({
      firstName: 'A',
      lastName: 'B',
      email: `staff.${Date.now()}.${Math.random()}@example.com`,
      phoneNumber: `080${Math.floor(Math.random() * 1e8)}`,
      passwordHash: 'hashed',
      role,
      departmentId: new Types.ObjectId(),
      unitId: new Types.ObjectId(),
      branchId: new Types.ObjectId(),
      moduleAccess: [],
      status: StaffStatus.ACTIVE,
    });
  }

  let moduleRef: TestingModule;
  let service: BranchFundingService;
  let assignmentService: BranchManagerAssignmentService;
  let balanceService: BranchFundBalanceService;
  let fundingModel: Model<BranchFundingDocument>;

  beforeAll(async () => {
    await mongo.start();

    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri()),
        MongooseModule.forFeature([
          { name: BranchFunding.name, schema: BranchFundingSchema },
          { name: BranchFundBalance.name, schema: BranchFundBalanceSchema },
          { name: BranchManagerAssignment.name, schema: BranchManagerAssignmentSchema },
          { name: Staff.name, schema: StaffSchema },
        ]),
        AuditModule,
      ],
      providers: [BranchFundingService, BranchManagerAssignmentService, BranchFundBalanceService],
    }).compile();

    service = moduleRef.get(BranchFundingService);
    assignmentService = moduleRef.get(BranchManagerAssignmentService);
    balanceService = moduleRef.get(BranchFundBalanceService);
    fundingModel = moduleRef.get(getModelToken(BranchFunding.name));
  }, 60_000);

  afterEach(async () => {
    await mongo.clearAllCollections();
  });

  afterAll(async () => {
    await moduleRef.close();
    await mongo.stop();
  });

  async function setUpBranchWithManager(): Promise<{ branchId: string; manager: StaffDocument }> {
    const branchId = new Types.ObjectId().toString();
    const manager = await createStaff(StaffRole.MANAGER);
    await assignmentService.assignManager(branchId, manager._id.toString(), 'head-office-1');
    return { branchId, manager };
  }

  describe('recordFunding', () => {
    it('creates a PENDING_VERIFICATION record and does not touch the balance', async () => {
      const { branchId } = await setUpBranchWithManager();

      const funding = await service.recordFunding(
        { branchId, amount: 500_000, fundedAt: new Date().toISOString() },
        'head-office-1',
      );

      expect(funding.status).toBe(BranchFundingStatus.PENDING_VERIFICATION);
      expect(await balanceService.getBalance(branchId)).toBe(0);
    });
  });

  describe('verifyFunding', () => {
    it('rejects when called by anyone other than the branch current manager, even an Admin/SuperAdmin', async () => {
      const { branchId } = await setUpBranchWithManager();
      const funding = await service.recordFunding(
        { branchId, amount: 500_000, fundedAt: new Date().toISOString() },
        'head-office-1',
      );
      const superadmin = await createStaff(StaffRole.SUPERADMIN);

      await expect(
        service.verifyFunding(funding._id.toString(), superadmin._id.toString()),
      ).rejects.toThrow(ForbiddenException);

      const reloaded = await fundingModel.findById(funding._id).exec();
      expect(reloaded?.status).toBe(BranchFundingStatus.PENDING_VERIFICATION);
    });

    it('rejects on an already-verified record', async () => {
      const { branchId, manager } = await setUpBranchWithManager();
      const funding = await service.recordFunding(
        { branchId, amount: 500_000, fundedAt: new Date().toISOString() },
        'head-office-1',
      );
      await service.verifyFunding(funding._id.toString(), manager._id.toString());

      await expect(
        service.verifyFunding(funding._id.toString(), manager._id.toString()),
      ).rejects.toThrow(ConflictException);
    });

    it('rejects on an already-rejected record', async () => {
      const { branchId, manager } = await setUpBranchWithManager();
      const funding = await service.recordFunding(
        { branchId, amount: 500_000, fundedAt: new Date().toISOString() },
        'head-office-1',
      );
      await service.rejectFunding(funding._id.toString(), manager._id.toString(), 'not received');

      await expect(
        service.verifyFunding(funding._id.toString(), manager._id.toString()),
      ).rejects.toThrow(ConflictException);
    });

    it('atomically updates both BranchFunding.status and BranchFundBalance.availableAmount on success', async () => {
      const { branchId, manager } = await setUpBranchWithManager();
      const funding = await service.recordFunding(
        { branchId, amount: 500_000, fundedAt: new Date().toISOString() },
        'head-office-1',
      );

      const updated = await service.verifyFunding(funding._id.toString(), manager._id.toString());

      expect(updated.status).toBe(BranchFundingStatus.VERIFIED);
      expect(updated.verifiedBy?.toString()).toBe(manager._id.toString());
      expect(await balanceService.getBalance(branchId)).toBe(500_000);
    });
  });

  describe('rejectFunding', () => {
    it('rejects when called by anyone other than the branch current manager', async () => {
      const { branchId } = await setUpBranchWithManager();
      const funding = await service.recordFunding(
        { branchId, amount: 500_000, fundedAt: new Date().toISOString() },
        'head-office-1',
      );
      const admin = await createStaff(StaffRole.ADMIN);

      await expect(
        service.rejectFunding(funding._id.toString(), admin._id.toString(), 'reason'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('sets status REJECTED with the reason and never touches the balance', async () => {
      const { branchId, manager } = await setUpBranchWithManager();
      const funding = await service.recordFunding(
        { branchId, amount: 500_000, fundedAt: new Date().toISOString() },
        'head-office-1',
      );

      const rejected = await service.rejectFunding(
        funding._id.toString(),
        manager._id.toString(),
        'transfer reversed',
      );

      expect(rejected.status).toBe(BranchFundingStatus.REJECTED);
      expect(rejected.rejectionReason).toBe('transfer reversed');
      expect(await balanceService.getBalance(branchId)).toBe(0);
    });
  });
});

describe('BranchFundingService — transaction rollback on partial failure', () => {
  const mongo = new InMemoryMongo();
  let moduleRef: TestingModule;
  let service: BranchFundingService;
  let assignmentService: BranchManagerAssignmentService;
  let fundingModel: Model<BranchFundingDocument>;
  let balanceModel: Model<BranchFundBalanceDocument>;

  beforeAll(async () => {
    await mongo.start();

    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri()),
        MongooseModule.forFeature([
          { name: BranchFunding.name, schema: BranchFundingSchema },
          { name: BranchFundBalance.name, schema: BranchFundBalanceSchema },
          { name: BranchManagerAssignment.name, schema: BranchManagerAssignmentSchema },
          { name: Staff.name, schema: StaffSchema },
        ]),
        AuditModule,
      ],
      providers: [
        BranchFundingService,
        BranchManagerAssignmentService,
        {
          // Simulates a failure partway through the transaction — credit()
          // throws after the funding status update has already been issued
          // (but not yet committed, since both happen inside the same
          // session.withTransaction callback).
          provide: BranchFundBalanceService,
          useValue: {
            credit: jest.fn().mockRejectedValue(new Error('simulated credit failure')),
          },
        },
      ],
    }).compile();

    service = moduleRef.get(BranchFundingService);
    assignmentService = moduleRef.get(BranchManagerAssignmentService);
    fundingModel = moduleRef.get(getModelToken(BranchFunding.name));
    balanceModel = moduleRef.get(getModelToken(BranchFundBalance.name));
  }, 60_000);

  afterAll(async () => {
    await moduleRef.close();
    await mongo.stop();
  });

  it('rolls back the funding status change when the balance credit fails partway through', async () => {
    const branchId = new Types.ObjectId().toString();
    const staffModel = moduleRef.get<Model<StaffDocument>>(getModelToken(Staff.name));
    const manager = await staffModel.create({
      firstName: 'A',
      lastName: 'B',
      email: `manager.${Date.now()}@example.com`,
      phoneNumber: `080${Math.floor(Math.random() * 1e8)}`,
      passwordHash: 'hashed',
      role: StaffRole.MANAGER,
      departmentId: new Types.ObjectId(),
      unitId: new Types.ObjectId(),
      branchId: new Types.ObjectId(),
      moduleAccess: [],
      status: StaffStatus.ACTIVE,
    });
    await assignmentService.assignManager(branchId, manager._id.toString(), 'head-office-1');
    const funding = await service.recordFunding(
      { branchId, amount: 500_000, fundedAt: new Date().toISOString() },
      'head-office-1',
    );

    await expect(
      service.verifyFunding(funding._id.toString(), manager._id.toString()),
    ).rejects.toThrow('simulated credit failure');

    // The transaction must have rolled back — status change never committed.
    const reloaded = await fundingModel.findById(funding._id).exec();
    expect(reloaded?.status).toBe(BranchFundingStatus.PENDING_VERIFICATION);
    expect(reloaded?.verifiedBy).toBeNull();

    // No balance document should exist (or if it does, from some other path,
    // it must not reflect this credit) — nothing was ever committed for this branch.
    const balanceDoc = await balanceModel.findOne({ branchId }).exec();
    expect(balanceDoc).toBeNull();
  });
});
