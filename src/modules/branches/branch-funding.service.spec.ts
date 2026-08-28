import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model, Types } from 'mongoose';

import { StaffRole, StaffStatus } from '../../common/enums/identity.enums';
import { BranchBankAccountPurpose, BranchFundingStatus } from '../../common/enums/branch.enums';
import { AuditModule } from '../../platform/audit/audit.module';
import { S3_ADAPTER } from '../../platform/integrations/s3/interfaces/s3-adapter.interface';
import {
  WorkflowChainConfig,
  WorkflowChainConfigSchema,
} from '../../platform/workflow-engine/schemas/workflow-chain-config.schema';
import { WorkflowRequest, WorkflowRequestSchema } from '../../platform/workflow-engine/schemas/workflow-request.schema';
import { WorkflowEngineService } from '../../platform/workflow-engine/workflow-engine.service';
import { InMemoryMongo } from '../../test-utils/in-memory-mongo';
import { Staff, StaffDocument, StaffSchema } from '../identity/schemas/staff.schema';
import { BranchBankAccountsService } from './branch-bank-accounts.service';
import { BranchFundBalanceService } from './branch-fund-balance.service';
import { BranchFundingService } from './branch-funding.service';
// BranchFundingService's constructor requires this (see its own doc
// comment) — this spec doesn't test manager-assignment logic itself, but
// still has to satisfy the real dependency graph, now that assigning a
// manager is a full maker-checker workflow (WorkflowEngineService + the
// Branch/WorkflowChainConfig/WorkflowRequest schemas it in turn needs).
import { BranchManagerAssignmentService } from './branch-manager-assignment.service';
import { BranchesService } from './branches.service';
import {
  BranchBankAccount,
  BranchBankAccountSchema,
} from './schemas/branch-bank-account.schema';
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
  BranchManagerAssignmentDocument,
  BranchManagerAssignmentSchema,
} from './schemas/branch-manager-assignment.schema';
import { Branch, BranchSchema } from './schemas/branch.schema';

describe('BranchFundingService', () => {
  const mongo = new InMemoryMongo();
  // Stand-ins for a head-office/admin actor who isn't otherwise a Staff
  // fixture in a given test — must be valid ObjectId hex strings, not an
  // arbitrary label, now that branchId/recordedBy/etc. are real
  // ObjectId-typed schema paths (see branch-funding.schema.ts) rather than
  // untyped Mixed ones that silently accepted anything.
  const HEAD_OFFICE_ACTOR_ID = new Types.ObjectId().toString();
  const ADMIN_ACTOR_ID = new Types.ObjectId().toString();

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
  let assignmentModel: Model<BranchManagerAssignmentDocument>;
  let balanceService: BranchFundBalanceService;
  let bankAccountsService: BranchBankAccountsService;
  let fundingModel: Model<BranchFundingDocument>;

  // BranchFundingService only calls BranchesService.findById(branchId) to
  // gate on `.active` (see BranchFundingService.recordFunding) — no test in
  // this spec creates a real Branch document (branchId here is just a bare
  // foreign key shared across BranchManagerAssignment/BranchBankAccount/
  // BranchFundBalance), so a stub stands in rather than wiring the full
  // BranchesService (which itself needs Staff/Loan/Customer/Group/workflow
  // engine dependencies unrelated to what this spec is testing). Defaults to
  // an active branch; individual tests override the mock to cover the
  // inactive-branch-cannot-be-funded rule.
  const branchesServiceMock = { findById: jest.fn().mockResolvedValue({ active: true }) };
  // BranchFundingService.raiseDispute/getDisputeEvidenceSignedUrl are the
  // only callers — no test in this spec exercises disputes (that's covered
  // in a dedicated describe block below), so a bare stub is enough to
  // satisfy the constructor dependency.
  const s3AdapterMock = {
    upload: jest.fn().mockResolvedValue({ key: 'mock-key' }),
    getSignedReadUrl: jest.fn().mockResolvedValue('https://example.com/mock-signed-url'),
    delete: jest.fn().mockResolvedValue(undefined),
  };

  beforeAll(async () => {
    await mongo.start();

    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri()),
        MongooseModule.forFeature([
          { name: BranchFunding.name, schema: BranchFundingSchema },
          { name: BranchFundBalance.name, schema: BranchFundBalanceSchema },
          { name: BranchManagerAssignment.name, schema: BranchManagerAssignmentSchema },
          { name: BranchBankAccount.name, schema: BranchBankAccountSchema },
          { name: Staff.name, schema: StaffSchema },
          { name: Branch.name, schema: BranchSchema },
          { name: WorkflowChainConfig.name, schema: WorkflowChainConfigSchema },
          { name: WorkflowRequest.name, schema: WorkflowRequestSchema },
        ]),
        AuditModule,
        EventEmitterModule.forRoot(),
      ],
      providers: [
        BranchFundingService,
        BranchFundBalanceService,
        BranchBankAccountsService,
        BranchManagerAssignmentService,
        WorkflowEngineService,
        { provide: BranchesService, useValue: branchesServiceMock },
        { provide: S3_ADAPTER, useValue: s3AdapterMock },
      ],
    }).compile();

    service = moduleRef.get(BranchFundingService);
    assignmentModel = moduleRef.get(getModelToken(BranchManagerAssignment.name));
    balanceService = moduleRef.get(BranchFundBalanceService);
    bankAccountsService = moduleRef.get(BranchBankAccountsService);
    fundingModel = moduleRef.get(getModelToken(BranchFunding.name));

    await moduleRef.init();
  }, 60_000);

  afterEach(() => {
    branchesServiceMock.findById.mockClear();
    branchesServiceMock.findById.mockResolvedValue({ active: true });
  });

  afterEach(async () => {
    await mongo.clearAllCollections();
  });

  afterAll(async () => {
    await moduleRef.close();
    await mongo.stop();
  });

  async function setUpBranchWithManager(): Promise<{ branchId: string; manager: StaffDocument; bankAccountId: string }> {
    const branchId = new Types.ObjectId().toString();
    const manager = await createStaff(StaffRole.MANAGER);
    // Fixture setup only — inserted directly rather than through
    // BranchManagerAssignmentService, which is now a full maker-checker
    // workflow (see BranchManagerAssignmentService's own doc comment) this
    // spec has no interest in exercising; it only needs a branch to already
    // have a manager on record.
    await assignmentModel.create({
      branchId: new Types.ObjectId(branchId),
      staffId: manager._id,
      startDate: new Date(),
      endDate: null,
      assignedBy: new Types.ObjectId(HEAD_OFFICE_ACTOR_ID),
      approvedBy: new Types.ObjectId(HEAD_OFFICE_ACTOR_ID),
    });
    // First account for the branch — active automatically, see
    // BranchBankAccountsService.create's own doc comment. accountNumber is
    // globally unique (see the schema's own index comment), so it's
    // randomized here to let this helper be called more than once per test.
    const account = await bankAccountsService.create({
      branchId,
      bankName: 'First Coop Bank',
      accountNumber: `0${Math.floor(Math.random() * 1e9)}`,
      accountName: 'Branch Collection Account',
      purpose: BranchBankAccountPurpose.GENERAL,
    });
    return { branchId, manager, bankAccountId: account._id.toString() };
  }

  describe('recordFunding', () => {
    it('creates a PENDING_VERIFICATION record and does not touch the balance', async () => {
      const { branchId, bankAccountId } = await setUpBranchWithManager();

      const funding = await service.recordFunding(
        { branchId, bankAccountId, amount: 500_000, fundedAt: new Date().toISOString() },
        HEAD_OFFICE_ACTOR_ID,
      );

      expect(funding.status).toBe(BranchFundingStatus.PENDING_VERIFICATION);
      expect(funding.bankAccountId.toString()).toBe(bankAccountId);
      expect(await balanceService.getBalance(branchId)).toBe(0);
    });

    it('rejects when the bank account does not belong to this branch', async () => {
      const { branchId } = await setUpBranchWithManager();
      const otherBranch = await setUpBranchWithManager();

      await expect(
        service.recordFunding(
          { branchId, bankAccountId: otherBranch.bankAccountId, amount: 500_000, fundedAt: new Date().toISOString() },
          HEAD_OFFICE_ACTOR_ID,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects when the bank account is not active', async () => {
      const { branchId, bankAccountId } = await setUpBranchWithManager();
      // A second account for the same branch automatically deactivates the first.
      await bankAccountsService.create({
        branchId,
        bankName: 'Second Bank',
        accountNumber: '9999999999',
        accountName: 'Branch Collection Account 2',
        purpose: BranchBankAccountPurpose.GENERAL,
        active: true,
      });

      await expect(
        service.recordFunding(
          { branchId, bankAccountId, amount: 500_000, fundedAt: new Date().toISOString() },
          HEAD_OFFICE_ACTOR_ID,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects funding an inactive branch', async () => {
      const { branchId, bankAccountId } = await setUpBranchWithManager();
      branchesServiceMock.findById.mockResolvedValueOnce({ active: false });

      await expect(
        service.recordFunding(
          { branchId, bankAccountId, amount: 500_000, fundedAt: new Date().toISOString() },
          HEAD_OFFICE_ACTOR_ID,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects funding a branch with no manager assigned', async () => {
      const branchId = new Types.ObjectId().toString();
      const account = await bankAccountsService.create({
        branchId,
        bankName: 'First Coop Bank',
        accountNumber: `0${Math.floor(Math.random() * 1e9)}`,
        accountName: 'Branch Collection Account',
        purpose: BranchBankAccountPurpose.GENERAL,
      });

      await expect(
        service.recordFunding(
          { branchId, bankAccountId: account._id.toString(), amount: 500_000, fundedAt: new Date().toISOString() },
          HEAD_OFFICE_ACTOR_ID,
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('verifyFunding', () => {
    it('rejects when called by anyone other than the branch current manager, even an Admin/SuperAdmin', async () => {
      const { branchId, bankAccountId } = await setUpBranchWithManager();
      const funding = await service.recordFunding(
        { branchId, bankAccountId, amount: 500_000, fundedAt: new Date().toISOString() },
        HEAD_OFFICE_ACTOR_ID,
      );
      const superadmin = await createStaff(StaffRole.SUPERADMIN);

      await expect(
        service.verifyFunding(funding._id.toString(), superadmin._id.toString()),
      ).rejects.toThrow(ForbiddenException);

      const reloaded = await fundingModel.findById(funding._id).exec();
      expect(reloaded?.status).toBe(BranchFundingStatus.PENDING_VERIFICATION);
    });

    it('rejects on an already-verified record', async () => {
      const { branchId, manager, bankAccountId } = await setUpBranchWithManager();
      const funding = await service.recordFunding(
        { branchId, bankAccountId, amount: 500_000, fundedAt: new Date().toISOString() },
        HEAD_OFFICE_ACTOR_ID,
      );
      await service.verifyFunding(funding._id.toString(), manager._id.toString());

      await expect(
        service.verifyFunding(funding._id.toString(), manager._id.toString()),
      ).rejects.toThrow(ConflictException);
    });

    it('rejects on an already-rejected record', async () => {
      const { branchId, manager, bankAccountId } = await setUpBranchWithManager();
      const funding = await service.recordFunding(
        { branchId, bankAccountId, amount: 500_000, fundedAt: new Date().toISOString() },
        HEAD_OFFICE_ACTOR_ID,
      );
      await service.rejectFunding(funding._id.toString(), manager._id.toString(), 'not received');

      await expect(
        service.verifyFunding(funding._id.toString(), manager._id.toString()),
      ).rejects.toThrow(ConflictException);
    });

    it('atomically updates both BranchFunding.status and BranchFundBalance.availableAmount on success', async () => {
      const { branchId, manager, bankAccountId } = await setUpBranchWithManager();
      const funding = await service.recordFunding(
        { branchId, bankAccountId, amount: 500_000, fundedAt: new Date().toISOString() },
        HEAD_OFFICE_ACTOR_ID,
      );

      const updated = await service.verifyFunding(funding._id.toString(), manager._id.toString());

      expect(updated.status).toBe(BranchFundingStatus.VERIFIED);
      expect(updated.verifiedBy?.toString()).toBe(manager._id.toString());
      expect(await balanceService.getBalance(branchId)).toBe(500_000);
    });
  });

  describe('rejectFunding', () => {
    it('rejects when called by anyone other than the branch current manager', async () => {
      const { branchId, bankAccountId } = await setUpBranchWithManager();
      const funding = await service.recordFunding(
        { branchId, bankAccountId, amount: 500_000, fundedAt: new Date().toISOString() },
        HEAD_OFFICE_ACTOR_ID,
      );
      const admin = await createStaff(StaffRole.ADMIN);

      await expect(
        service.rejectFunding(funding._id.toString(), admin._id.toString(), 'reason'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('sets status REJECTED with the reason and never touches the balance', async () => {
      const { branchId, manager, bankAccountId } = await setUpBranchWithManager();
      const funding = await service.recordFunding(
        { branchId, bankAccountId, amount: 500_000, fundedAt: new Date().toISOString() },
        HEAD_OFFICE_ACTOR_ID,
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

  describe('nudgeManager', () => {
    it('rejects nudging a record that is no longer PENDING_VERIFICATION', async () => {
      const { branchId, manager, bankAccountId } = await setUpBranchWithManager();
      const funding = await service.recordFunding(
        { branchId, bankAccountId, amount: 500_000, fundedAt: new Date().toISOString() },
        HEAD_OFFICE_ACTOR_ID,
      );
      await service.verifyFunding(funding._id.toString(), manager._id.toString());

      await expect(service.nudgeManager(funding._id.toString(), HEAD_OFFICE_ACTOR_ID)).rejects.toThrow(
        ConflictException,
      );
    });

    it('stamps lastNudgedAt on a still-pending record', async () => {
      const { branchId, bankAccountId } = await setUpBranchWithManager();
      const funding = await service.recordFunding(
        { branchId, bankAccountId, amount: 500_000, fundedAt: new Date().toISOString() },
        HEAD_OFFICE_ACTOR_ID,
      );

      const nudged = await service.nudgeManager(funding._id.toString(), HEAD_OFFICE_ACTOR_ID);
      expect(nudged.lastNudgedAt).not.toBeNull();
    });
  });

  describe('disputes', () => {
    const evidence = { buffer: Buffer.from('fake-evidence'), contentType: 'image/png' };

    it('rejects raising a dispute for anyone other than the branch current manager', async () => {
      const { branchId, bankAccountId } = await setUpBranchWithManager();
      const funding = await service.recordFunding(
        { branchId, bankAccountId, amount: 500_000, fundedAt: new Date().toISOString() },
        HEAD_OFFICE_ACTOR_ID,
      );
      const admin = await createStaff(StaffRole.ADMIN);

      await expect(
        service.raiseDispute(funding._id.toString(), admin._id.toString(), 'wrong amount', evidence),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects raising a dispute on an already-verified funding record', async () => {
      const { branchId, manager, bankAccountId } = await setUpBranchWithManager();
      const funding = await service.recordFunding(
        { branchId, bankAccountId, amount: 500_000, fundedAt: new Date().toISOString() },
        HEAD_OFFICE_ACTOR_ID,
      );
      await service.verifyFunding(funding._id.toString(), manager._id.toString());

      await expect(
        service.raiseDispute(funding._id.toString(), manager._id.toString(), 'wrong amount', evidence),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects raising a dispute on an already-rejected funding record', async () => {
      const { branchId, manager, bankAccountId } = await setUpBranchWithManager();
      const funding = await service.recordFunding(
        { branchId, bankAccountId, amount: 500_000, fundedAt: new Date().toISOString() },
        HEAD_OFFICE_ACTOR_ID,
      );
      await service.rejectFunding(funding._id.toString(), manager._id.toString(), 'wrong branch');

      await expect(
        service.raiseDispute(funding._id.toString(), manager._id.toString(), 'wrong amount', evidence),
      ).rejects.toThrow(BadRequestException);
    });

    it('raises a dispute with the required evidence key and reason, without touching status', async () => {
      const { branchId, manager, bankAccountId } = await setUpBranchWithManager();
      const funding = await service.recordFunding(
        { branchId, bankAccountId, amount: 500_000, fundedAt: new Date().toISOString() },
        HEAD_OFFICE_ACTOR_ID,
      );

      const disputed = await service.raiseDispute(
        funding._id.toString(),
        manager._id.toString(),
        'wrong amount',
        evidence,
      );

      expect(disputed.status).toBe(BranchFundingStatus.PENDING_VERIFICATION);
      expect(disputed.disputeDetails?.reason).toBe('wrong amount');
      expect(disputed.disputeDetails?.evidenceImageKey).toBeTruthy();
      expect(disputed.disputeDetails?.resolution).toBeNull();
    });

    it('rejects raising a second dispute while one is still open', async () => {
      const { branchId, manager, bankAccountId } = await setUpBranchWithManager();
      const funding = await service.recordFunding(
        { branchId, bankAccountId, amount: 500_000, fundedAt: new Date().toISOString() },
        HEAD_OFFICE_ACTOR_ID,
      );
      await service.raiseDispute(funding._id.toString(), manager._id.toString(), 'first', evidence);

      await expect(
        service.raiseDispute(funding._id.toString(), manager._id.toString(), 'second', evidence),
      ).rejects.toThrow(ConflictException);
    });

    it('rejects resolving a funding record with no open dispute', async () => {
      const { branchId, bankAccountId } = await setUpBranchWithManager();
      const funding = await service.recordFunding(
        { branchId, bankAccountId, amount: 500_000, fundedAt: new Date().toISOString() },
        HEAD_OFFICE_ACTOR_ID,
      );

      await expect(
        service.resolveDispute(funding._id.toString(), ADMIN_ACTOR_ID, 'RESOLVED', 'noted'),
      ).rejects.toThrow(ConflictException);
    });

    it('resolves an open dispute and allows a new one to be raised afterward', async () => {
      const { branchId, manager, bankAccountId } = await setUpBranchWithManager();
      const funding = await service.recordFunding(
        { branchId, bankAccountId, amount: 500_000, fundedAt: new Date().toISOString() },
        HEAD_OFFICE_ACTOR_ID,
      );
      await service.raiseDispute(funding._id.toString(), manager._id.toString(), 'first', evidence);

      const resolved = await service.resolveDispute(funding._id.toString(), ADMIN_ACTOR_ID, 'RESOLVED', 'refunded');
      expect(resolved.disputeDetails?.resolution).toBe('RESOLVED');
      expect(resolved.disputeDetails?.resolutionNote).toBe('refunded');

      const redisputed = await service.raiseDispute(
        funding._id.toString(),
        manager._id.toString(),
        'second',
        evidence,
      );
      expect(redisputed.disputeDetails?.reason).toBe('second');
      expect(redisputed.disputeDetails?.resolution).toBeNull();
    });
  });
});

describe('BranchFundingService — transaction rollback on partial failure', () => {
  const mongo = new InMemoryMongo();
  // See the top describe block's own comment on HEAD_OFFICE_ACTOR_ID — same
  // reasoning, just re-declared since it's a separate top-level describe.
  const HEAD_OFFICE_ACTOR_ID = new Types.ObjectId().toString();
  let moduleRef: TestingModule;
  let service: BranchFundingService;
  let assignmentModel: Model<BranchManagerAssignmentDocument>;
  let bankAccountsService: BranchBankAccountsService;
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
          { name: BranchBankAccount.name, schema: BranchBankAccountSchema },
          { name: Staff.name, schema: StaffSchema },
          { name: Branch.name, schema: BranchSchema },
          { name: WorkflowChainConfig.name, schema: WorkflowChainConfigSchema },
          { name: WorkflowRequest.name, schema: WorkflowRequestSchema },
        ]),
        AuditModule,
        EventEmitterModule.forRoot(),
      ],
      providers: [
        BranchFundingService,
        BranchBankAccountsService,
        BranchManagerAssignmentService,
        WorkflowEngineService,
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
        { provide: BranchesService, useValue: { findById: jest.fn().mockResolvedValue({ active: true }) } },
        {
          provide: S3_ADAPTER,
          useValue: {
            upload: jest.fn().mockResolvedValue({ key: 'mock-key' }),
            getSignedReadUrl: jest.fn().mockResolvedValue('https://example.com/mock-signed-url'),
            delete: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = moduleRef.get(BranchFundingService);
    assignmentModel = moduleRef.get(getModelToken(BranchManagerAssignment.name));
    bankAccountsService = moduleRef.get(BranchBankAccountsService);
    fundingModel = moduleRef.get(getModelToken(BranchFunding.name));
    balanceModel = moduleRef.get(getModelToken(BranchFundBalance.name));

    await moduleRef.init();
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
    // Fixture setup only — see the top describe block's own comment on why
    // this inserts directly rather than through BranchManagerAssignmentService.
    await assignmentModel.create({
      branchId: new Types.ObjectId(branchId),
      staffId: manager._id,
      startDate: new Date(),
      endDate: null,
      assignedBy: new Types.ObjectId(HEAD_OFFICE_ACTOR_ID),
      approvedBy: new Types.ObjectId(HEAD_OFFICE_ACTOR_ID),
    });
    const account = await bankAccountsService.create({
      branchId,
      bankName: 'First Coop Bank',
      accountNumber: '0123456789',
      accountName: 'Branch Collection Account',
      purpose: BranchBankAccountPurpose.GENERAL,
    });
    const funding = await service.recordFunding(
      { branchId, bankAccountId: account._id.toString(), amount: 500_000, fundedAt: new Date().toISOString() },
      HEAD_OFFICE_ACTOR_ID,
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
