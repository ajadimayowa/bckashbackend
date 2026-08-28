import { ConflictException } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model, Types } from 'mongoose';

import { StaffRole, StaffUserType } from '../../common/enums/identity.enums';
import { LoanStatus } from '../../common/enums/loan.enums';
import { WorkflowEntityType, WorkflowStepAction } from '../../common/enums/workflow.enums';
import { AuditModule } from '../../platform/audit/audit.module';
import { approveCapability } from '../../platform/rbac/constants/capabilities';
import { ActingStaff } from '../../platform/workflow-engine/interfaces/workflow-engine.interfaces';
import {
  WorkflowChainConfig,
  WorkflowChainConfigSchema,
} from '../../platform/workflow-engine/schemas/workflow-chain-config.schema';
import { WorkflowRequest, WorkflowRequestSchema } from '../../platform/workflow-engine/schemas/workflow-request.schema';
import { WorkflowEngineService } from '../../platform/workflow-engine/workflow-engine.service';
import { InMemoryMongo } from '../../test-utils/in-memory-mongo';
import { Customer, CustomerSchema } from '../customers/schemas/customer.schema';
import { Group, GroupSchema } from '../groups/schemas/group.schema';
import { Staff, StaffDocument, StaffSchema } from '../identity/schemas/staff.schema';
import { Loan, LoanDocument, LoanSchema } from '../loans/schemas/loan.schema';
import { BranchBankAccount, BranchBankAccountSchema } from './schemas/branch-bank-account.schema';
import { BranchFundBalance, BranchFundBalanceSchema } from './schemas/branch-fund-balance.schema';
import { BranchesService } from './branches.service';
import { Branch, BranchDocument, BranchSchema } from './schemas/branch.schema';

describe('BranchesService', () => {
  const mongo = new InMemoryMongo();
  let moduleRef: TestingModule;
  let service: BranchesService;
  let workflowEngineService: WorkflowEngineService;
  let branchModel: Model<BranchDocument>;
  let staffModel: Model<StaffDocument>;
  let loanModel: Model<LoanDocument>;

  const INITIATOR_ID = new Types.ObjectId().toString();
  const APPROVER_ID = new Types.ObjectId().toString();

  const APPROVE_ACTOR: ActingStaff = {
    staffId: APPROVER_ID,
    capabilities: [approveCapability(WorkflowEntityType.BRANCH)],
  };

  beforeAll(async () => {
    await mongo.start();

    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri()),
        MongooseModule.forFeature([
          { name: Branch.name, schema: BranchSchema },
          { name: Staff.name, schema: StaffSchema },
          { name: Loan.name, schema: LoanSchema },
          { name: Customer.name, schema: CustomerSchema },
          { name: Group.name, schema: GroupSchema },
          { name: BranchFundBalance.name, schema: BranchFundBalanceSchema },
          { name: BranchBankAccount.name, schema: BranchBankAccountSchema },
          { name: WorkflowChainConfig.name, schema: WorkflowChainConfigSchema },
          { name: WorkflowRequest.name, schema: WorkflowRequestSchema },
        ]),
        AuditModule,
        EventEmitterModule.forRoot(),
      ],
      providers: [BranchesService, WorkflowEngineService],
    }).compile();

    service = moduleRef.get(BranchesService);
    workflowEngineService = moduleRef.get(WorkflowEngineService);
    branchModel = moduleRef.get(getModelToken(Branch.name));
    staffModel = moduleRef.get(getModelToken(Staff.name));
    loanModel = moduleRef.get(getModelToken(Loan.name));

    await moduleRef.init();
  }, 60_000);

  afterEach(async () => {
    const collectionsToKeep = new Set(['workflow_chain_configs']);
    const collections = await branchModel.db.db!.collections();
    await Promise.all(
      collections.filter((c) => !collectionsToKeep.has(c.collectionName)).map((c) => c.deleteMany({})),
    );
  });

  afterAll(async () => {
    await moduleRef.close();
    await mongo.stop();
  });

  function branchDto(overrides: Partial<{ name: string; code: string; address: string }> = {}) {
    return { name: 'Ikeja Branch', code: 'IKJ', address: '1 Allen Avenue', ...overrides };
  }

  async function approve(requestId: string, actor: ActingStaff = APPROVE_ACTOR): Promise<void> {
    await workflowEngineService.act({ workflowRequestId: requestId, actor, action: WorkflowStepAction.APPROVED });
  }

  async function createApprovedBranch(overrides: Partial<{ name: string; code: string; address: string }> = {}) {
    const request = await service.initiateCreation(branchDto(overrides), INITIATOR_ID);
    await approve(request._id.toString());
    return branchModel.findOne({ code: overrides.code ?? 'IKJ' }).exec();
  }

  describe('initiateCreation / approval workflow', () => {
    it('registers a single-step (approve-only) CREATE chain on module init', async () => {
      const chainConfigModel = moduleRef.get(getModelToken(WorkflowChainConfig.name));
      const config = await chainConfigModel
        .findOne({ entityType: WorkflowEntityType.BRANCH, action: 'CREATE' })
        .exec();
      expect(config?.steps).toHaveLength(1);
      expect(config?.steps[0]?.requiredCapability).toBe(approveCapability(WorkflowEntityType.BRANCH));
    });

    it('proposing a branch creates nothing until approved', async () => {
      const request = await service.initiateCreation(branchDto(), INITIATOR_ID);
      expect(request.status).toBe('PENDING_APPROVAL');
      expect(await branchModel.countDocuments().exec()).toBe(0);
    });

    it('the maker cannot approve their own proposal', async () => {
      const request = await service.initiateCreation(branchDto(), INITIATOR_ID);
      await expect(
        workflowEngineService.act({
          workflowRequestId: request._id.toString(),
          actor: { staffId: INITIATOR_ID, capabilities: [approveCapability(WorkflowEntityType.BRANCH)] },
          action: WorkflowStepAction.APPROVED,
        }),
      ).rejects.toThrow(/cannot act on their own request/);
    });

    it('on approval, creates an active branch and links the WorkflowRequest to it', async () => {
      const request = await service.initiateCreation(branchDto(), INITIATOR_ID);
      await approve(request._id.toString());

      const branch = await branchModel.findOne({ code: 'IKJ' }).exec();
      expect(branch).not.toBeNull();
      expect(branch!.active).toBe(true);
      expect(branch!.name).toBe('Ikeja Branch');

      const linked = await workflowEngineService.getById(request._id.toString());
      expect(linked.entityId).toBe(branch!._id.toString());
    });

    it('a rejected proposal never creates a branch', async () => {
      const request = await service.initiateCreation(branchDto(), INITIATOR_ID);
      await workflowEngineService.act({
        workflowRequestId: request._id.toString(),
        actor: APPROVE_ACTOR,
        action: WorkflowStepAction.REJECTED,
        comment: 'duplicate of an existing branch',
      });

      expect(await branchModel.countDocuments().exec()).toBe(0);
    });

    it('rejects proposing a duplicate code immediately, with a friendly ConflictException — before it ever reaches a second approver', async () => {
      await createApprovedBranch({ code: 'DUP' });

      await expect(
        service.initiateCreation(branchDto({ name: 'Different Name', code: 'DUP' }), INITIATOR_ID),
      ).rejects.toThrow(ConflictException);
    });

    it('is case-insensitive about the duplicate-code check (code is stored uppercase)', async () => {
      await createApprovedBranch({ code: 'DUP' });

      await expect(
        service.initiateCreation(branchDto({ name: 'Different Name', code: 'dup' }), INITIATOR_ID),
      ).rejects.toThrow(ConflictException);
    });

    it('two simultaneously-pending proposals with the same code: the first approval wins, the second silently creates nothing', async () => {
      // Neither collides with an *approved* branch at propose time (the
      // pre-check in initiateCreation can't see another still-pending
      // proposal), so both proposals succeed here — this is the one gap the
      // pre-check can't close, documented rather than hidden. @nestjs/
      // event-emitter only logs an exception thrown inside an @OnEvent
      // listener, it doesn't reject emitAsync()/act() — so the second
      // approval still reports back as a normal APPROVED status even though
      // persistBranch's own defensive check stops it from creating anything.
      const firstRequest = await service.initiateCreation(branchDto({ code: 'RACE' }), INITIATOR_ID);
      const secondRequest = await service.initiateCreation(branchDto({ name: 'Second Proposal', code: 'RACE' }), INITIATOR_ID);

      await approve(firstRequest._id.toString());
      await approve(secondRequest._id.toString(), {
        staffId: new Types.ObjectId().toString(),
        capabilities: [approveCapability(WorkflowEntityType.BRANCH)],
      });

      expect(await branchModel.countDocuments({ code: 'RACE' }).exec()).toBe(1);
      const secondLinked = await workflowEngineService.getById(secondRequest._id.toString());
      expect(secondLinked.status).toBe('APPROVED');
      expect(secondLinked.entityId).toBeNull();
    });
  });

  describe('createDirect', () => {
    it('creates an active branch immediately, bypassing the workflow — used only by the bootstrap seeder', async () => {
      const branch = await service.createDirect(branchDto());
      expect(branch.active).toBe(true);
      expect(branch.code).toBe('IKJ');
      expect(await branchModel.countDocuments().exec()).toBe(1);
    });
  });

  describe('getStats', () => {
    it('counts staff and DISBURSED loans scoped to the branch, ignoring other branches and other statuses', async () => {
      const branch = await service.createDirect(branchDto());
      const otherBranch = await service.createDirect(branchDto({ code: 'OTH' }));
      const branchId = branch._id.toString();

      const departmentId = new Types.ObjectId();
      const unitId = new Types.ObjectId();
      function staffFixture(overrides: Partial<Record<string, unknown>>) {
        return {
          firstName: 'A',
          lastName: 'One',
          phoneNumber: `080${Math.floor(Math.random() * 1e8)}`,
          passwordHash: 'hash',
          role: StaffRole.MARKETER,
          userType: StaffUserType.INITIATOR,
          departmentId,
          unitId,
          ...overrides,
        };
      }
      await staffModel.create([
        staffFixture({ branchId: new Types.ObjectId(branchId), email: 'a@x.com' }),
        staffFixture({ branchId: new Types.ObjectId(branchId), email: 'b@x.com', lastName: 'Two' }),
        staffFixture({ branchId: new Types.ObjectId(otherBranch._id.toString()), email: 'c@x.com', lastName: 'Three' }),
      ]);

      const groupId = new Types.ObjectId();
      const productId = new Types.ObjectId();
      const raisedBy = new Types.ObjectId();
      function loanFixture(overrides: Partial<Record<string, unknown>>) {
        return {
          groupId,
          productId,
          tenureDays: 14,
          cumulativeAmountKobo: 100_000,
          raisedBy,
          raisedAt: new Date(),
          ...overrides,
        };
      }
      await loanModel.create([
        loanFixture({ branchId: new Types.ObjectId(branchId), status: LoanStatus.DISBURSED }),
        loanFixture({ branchId: new Types.ObjectId(branchId), status: LoanStatus.PENDING_APPROVAL }),
        loanFixture({ branchId: new Types.ObjectId(otherBranch._id.toString()), status: LoanStatus.DISBURSED }),
      ]);

      const stats = await service.getStats(branchId);
      expect(stats).toEqual({ branchId, staffCount: 2, activeLoansCount: 1 });
    });

    it('returns zeros for a branch with no staff/loans, never throws', async () => {
      const branch = await service.createDirect(branchDto());
      const stats = await service.getStats(branch._id.toString());
      expect(stats.staffCount).toBe(0);
      expect(stats.activeLoansCount).toBe(0);
    });
  });

  describe('deleteBranch', () => {
    const ACTOR_ID = new Types.ObjectId().toString();

    it('deletes an ACTIVE branch with nothing referencing it — `active` is not a gate on its own', async () => {
      const branch = await service.createDirect(branchDto());
      expect(branch.active).toBe(true);

      await service.deleteBranch(branch._id.toString(), ACTOR_ID);

      expect(await branchModel.exists({ _id: branch._id })).toBeNull();
    });

    it('still deletes an INACTIVE branch with nothing referencing it (unchanged from before)', async () => {
      const branch = await service.createDirect(branchDto());
      await service.update(branch._id.toString(), { active: false }, ACTOR_ID);

      await service.deleteBranch(branch._id.toString(), ACTOR_ID);

      expect(await branchModel.exists({ _id: branch._id })).toBeNull();
    });

    it('rejects deleting an ACTIVE branch that still has staff assigned to it', async () => {
      const branch = await service.createDirect(branchDto());
      await staffModel.create({
        firstName: 'A',
        lastName: 'One',
        email: 'staffref@x.com',
        phoneNumber: `080${Math.floor(Math.random() * 1e8)}`,
        passwordHash: 'hash',
        role: StaffRole.MARKETER,
        userType: StaffUserType.INITIATOR,
        departmentId: new Types.ObjectId(),
        unitId: new Types.ObjectId(),
        branchId: branch._id,
      });

      await expect(service.deleteBranch(branch._id.toString(), ACTOR_ID)).rejects.toThrow(
        /still has records referencing it/,
      );
      expect(await branchModel.exists({ _id: branch._id })).not.toBeNull();
    });

    it('rejects deleting a branch (active or inactive) with loans/customers/groups still referencing it', async () => {
      const branch = await service.createDirect(branchDto({ code: 'LNS' }));
      await loanModel.create({
        branchId: branch._id,
        groupId: new Types.ObjectId(),
        productId: new Types.ObjectId(),
        tenureDays: 14,
        cumulativeAmountKobo: 100_000,
        raisedBy: new Types.ObjectId(),
        raisedAt: new Date(),
        status: LoanStatus.PENDING_APPROVAL,
      });

      await expect(service.deleteBranch(branch._id.toString(), ACTOR_ID)).rejects.toThrow(ConflictException);
      expect(await branchModel.exists({ _id: branch._id })).not.toBeNull();
    });
  });
});
