import { randomBytes } from 'node:crypto';

import { EventEmitterModule } from '@nestjs/event-emitter';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model, Types } from 'mongoose';

import { __resetPiiEncryptionKeyCache } from '../../common/crypto/pii-encryption';
import { GroupMemberRole } from '../../common/enums/group.enums';
import { CustomerStatus, KycStatus } from '../../common/enums/customer.enums';
import { WorkflowEntityType, WorkflowStepAction } from '../../common/enums/workflow.enums';
import { InMemoryMongo } from '../../test-utils/in-memory-mongo';
import { AuditModule } from '../../platform/audit/audit.module';
import { EncryptionService } from '../../platform/encryption/encryption.service';
import { BvnCallLogService } from '../../platform/integrations/bvn/bvn-call-log.service';
import { BVN_VERIFICATION_ADAPTER } from '../../platform/integrations/bvn/interfaces/bvn-verification-adapter.interface';
import { MockBvnVerificationAdapter } from '../../platform/integrations/bvn/mock-bvn-verification.adapter';
import {
  BvnCallLog,
  BvnCallLogSchema,
} from '../../platform/integrations/bvn/schemas/bvn-call-log.schema';
import { S3_ADAPTER } from '../../platform/integrations/s3/interfaces/s3-adapter.interface';
import { MockS3Service } from '../../platform/integrations/s3/mock-s3.service';
import { approveCapability, reviewCapability } from '../../platform/rbac/constants/capabilities';
import { ActingStaff } from '../../platform/workflow-engine/interfaces/workflow-engine.interfaces';
import {
  WorkflowChainConfig,
  WorkflowChainConfigSchema,
} from '../../platform/workflow-engine/schemas/workflow-chain-config.schema';
import {
  WorkflowRequest,
  WorkflowRequestDocument,
  WorkflowRequestSchema,
} from '../../platform/workflow-engine/schemas/workflow-request.schema';
import { WorkflowEngineService } from '../../platform/workflow-engine/workflow-engine.service';
import { Branch, BranchDocument, BranchSchema } from '../branches/schemas/branch.schema';
import { CustomerService } from '../customers/customer.service';
import { Customer, CustomerDocument, CustomerSchema } from '../customers/schemas/customer.schema';
import { KycRecord, KycRecordSchema } from '../customers/schemas/kyc-record.schema';
import {
  PendingBvnConsent,
  PendingBvnConsentSchema,
} from '../customers/schemas/pending-bvn-consent.schema';
import { GroupsService } from './groups.service';
import { LOAN_STATUS_PORT } from './interfaces/loan-status-port.interface';
import {
  GroupMembership,
  GroupMembershipDocument,
  GroupMembershipSchema,
} from './schemas/group-membership.schema';
import { Group, GroupDocument, GroupSchema } from './schemas/group.schema';

describe('GroupsService', () => {
  const mongo = new InMemoryMongo();

  let moduleRef: TestingModule;
  let service: GroupsService;
  let workflowEngineService: WorkflowEngineService;
  let groupModel: Model<GroupDocument>;
  let groupMembershipModel: Model<GroupMembershipDocument>;
  let customerModel: Model<CustomerDocument>;
  let branchModel: Model<BranchDocument>;
  let workflowRequestModel: Model<WorkflowRequestDocument>;
  let loanStatusPortMock: { hasPendingLoan: jest.Mock };
  let branchId: string;

  const INITIATOR_ID = new Types.ObjectId().toString();
  const REVIEWER_ID = new Types.ObjectId().toString();
  const APPROVER_ID = new Types.ObjectId().toString();
  const ADMIN_ID = new Types.ObjectId().toString();

  const REVIEW_GROUP_ACTOR: ActingStaff = {
    staffId: REVIEWER_ID,
    capabilities: [reviewCapability(WorkflowEntityType.GROUP)],
  };
  const APPROVE_GROUP_ACTOR: ActingStaff = {
    staffId: APPROVER_ID,
    capabilities: [approveCapability(WorkflowEntityType.GROUP)],
  };
  const REVIEW_MEMBERSHIP_ACTOR: ActingStaff = {
    staffId: REVIEWER_ID,
    capabilities: [reviewCapability(WorkflowEntityType.GROUP_MEMBERSHIP)],
  };
  const APPROVE_MEMBERSHIP_ACTOR: ActingStaff = {
    staffId: APPROVER_ID,
    capabilities: [approveCapability(WorkflowEntityType.GROUP_MEMBERSHIP)],
  };

  beforeAll(async () => {
    process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    __resetPiiEncryptionKeyCache();

    await mongo.start();

    loanStatusPortMock = { hasPendingLoan: jest.fn().mockResolvedValue(false) };

    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri()),
        MongooseModule.forFeature([
          { name: Group.name, schema: GroupSchema },
          { name: GroupMembership.name, schema: GroupMembershipSchema },
          { name: Branch.name, schema: BranchSchema },
          { name: Customer.name, schema: CustomerSchema },
          { name: KycRecord.name, schema: KycRecordSchema },
          { name: PendingBvnConsent.name, schema: PendingBvnConsentSchema },
          { name: WorkflowChainConfig.name, schema: WorkflowChainConfigSchema },
          { name: WorkflowRequest.name, schema: WorkflowRequestSchema },
          { name: BvnCallLog.name, schema: BvnCallLogSchema },
        ]),
        AuditModule,
        EventEmitterModule.forRoot(),
      ],
      providers: [
        GroupsService,
        WorkflowEngineService,
        CustomerService,
        EncryptionService,
        BvnCallLogService,
        MockBvnVerificationAdapter,
        MockS3Service,
        { provide: BVN_VERIFICATION_ADAPTER, useExisting: MockBvnVerificationAdapter },
        { provide: S3_ADAPTER, useExisting: MockS3Service },
        { provide: LOAN_STATUS_PORT, useValue: loanStatusPortMock },
      ],
    }).compile();

    service = moduleRef.get(GroupsService);
    workflowEngineService = moduleRef.get(WorkflowEngineService);
    groupModel = moduleRef.get(getModelToken(Group.name));
    groupMembershipModel = moduleRef.get(getModelToken(GroupMembership.name));
    customerModel = moduleRef.get(getModelToken(Customer.name));
    branchModel = moduleRef.get(getModelToken(Branch.name));
    workflowRequestModel = moduleRef.get(getModelToken(WorkflowRequest.name));

    await moduleRef.init(); // registers @OnEvent listeners
  }, 60_000);

  beforeEach(async () => {
    const branch = await branchModel.create({
      name: 'Main',
      code: `BR${Date.now()}${Math.random()}`,
      active: true,
    });
    branchId = branch._id.toString();
    loanStatusPortMock.hasPendingLoan.mockReset().mockResolvedValue(false);
  });

  afterEach(async () => {
    const collectionsToKeep = new Set(['workflow_chain_configs']);
    const connection = groupModel.db;
    const collections = await connection.db!.collections();
    await Promise.all(
      collections
        .filter((c) => !collectionsToKeep.has(c.collectionName))
        .map((c) => c.deleteMany({})),
    );
  });

  afterAll(async () => {
    await moduleRef.close();
    await mongo.stop();
  });

  // ---------------------------------------------------------------------------
  // Fixtures
  // ---------------------------------------------------------------------------

  let customerCounter = 0;
  async function createCustomer(kycStatus: KycStatus = KycStatus.VERIFIED): Promise<string> {
    customerCounter += 1;
    const customer = await customerModel.create({
      firstName: 'Test',
      lastName: `Customer${customerCounter}`,
      phoneNumber: `0800${customerCounter}${Date.now()}`.slice(0, 15),
      branchId,
      status: CustomerStatus.ACTIVE,
      kycStatus,
      createdBy: INITIATOR_ID,
    });
    return customer._id.toString();
  }

  async function createCustomers(n: number, kycStatus: KycStatus = KycStatus.VERIFIED) {
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      ids.push(await createCustomer(kycStatus));
    }
    return ids;
  }

  async function approveGroupCreation(request: WorkflowRequestDocument): Promise<void> {
    await workflowEngineService.act({
      workflowRequestId: request._id.toString(),
      actor: REVIEW_GROUP_ACTOR,
      action: WorkflowStepAction.APPROVED,
    });
    await workflowEngineService.act({
      workflowRequestId: request._id.toString(),
      actor: APPROVE_GROUP_ACTOR,
      action: WorkflowStepAction.APPROVED,
    });
  }

  async function approveMembershipRequest(request: WorkflowRequestDocument): Promise<void> {
    await workflowEngineService.act({
      workflowRequestId: request._id.toString(),
      actor: REVIEW_MEMBERSHIP_ACTOR,
      action: WorkflowStepAction.APPROVED,
    });
    await workflowEngineService.act({
      workflowRequestId: request._id.toString(),
      actor: APPROVE_MEMBERSHIP_ACTOR,
      action: WorkflowStepAction.APPROVED,
    });
  }

  async function createApprovedGroup(
    n = 3,
    kycStatus: KycStatus = KycStatus.VERIFIED,
  ): Promise<{ groupId: string; customerIds: string[] }> {
    const customerIds = await createCustomers(n, kycStatus);
    const name = `Group-${Date.now()}-${Math.random()}`;
    const request = await service.initiateCreation(
      { name, branchId, proposedMemberCustomerIds: customerIds },
      INITIATOR_ID,
    );
    await approveGroupCreation(request);
    const group = await groupModel.findOne({ name }).exec();
    if (!group) {
      throw new Error(`createApprovedGroup: no Group named ${name} found after approval`);
    }
    return { groupId: group._id.toString(), customerIds };
  }

  // ---------------------------------------------------------------------------
  // Creation
  // ---------------------------------------------------------------------------

  describe('initiateCreation', () => {
    it('rejects fewer than 3 proposed members before creating any WorkflowRequest', async () => {
      const customerIds = await createCustomers(2);
      const countBefore = await workflowRequestModel.countDocuments();

      await expect(
        service.initiateCreation(
          { name: 'Too Small', branchId, proposedMemberCustomerIds: customerIds },
          INITIATOR_ID,
        ),
      ).rejects.toThrow(/at least 3/);

      expect(await workflowRequestModel.countDocuments()).toBe(countBefore);
    });

    it('rejects duplicate customer IDs in the proposal', async () => {
      const customerId = (await createCustomers(1))[0]!;
      const others = await createCustomers(2);
      await expect(
        service.initiateCreation(
          {
            name: 'Dup',
            branchId,
            proposedMemberCustomerIds: [customerId, customerId, ...others],
          },
          INITIATOR_ID,
        ),
      ).rejects.toThrow(/duplicate/);
    });

    it('rejects a non-existent branchId', async () => {
      const customerIds = await createCustomers(3);
      await expect(
        service.initiateCreation(
          {
            name: 'Ghost Branch',
            branchId: new Types.ObjectId().toString(),
            proposedMemberCustomerIds: customerIds,
          },
          INITIATOR_ID,
        ),
      ).rejects.toThrow(/does not exist/);
    });

    it('rejects a non-existent proposed customer', async () => {
      const customerIds = await createCustomers(2);
      await expect(
        service.initiateCreation(
          {
            name: 'Ghost Customer',
            branchId,
            proposedMemberCustomerIds: [...customerIds, new Types.ObjectId().toString()],
          },
          INITIATOR_ID,
        ),
      ).rejects.toThrow(/do not exist/);
    });

    it('does not persist Group/GroupMembership until approved; rejection leaves nothing behind', async () => {
      const customerIds = await createCustomers(3);
      const request = await service.initiateCreation(
        { name: 'Coop Pending', branchId, proposedMemberCustomerIds: customerIds },
        INITIATOR_ID,
      );

      expect(await groupModel.countDocuments()).toBe(0);
      expect(await groupMembershipModel.countDocuments()).toBe(0);

      await workflowEngineService.act({
        workflowRequestId: request._id.toString(),
        actor: REVIEW_GROUP_ACTOR,
        action: WorkflowStepAction.REJECTED,
        comment: 'duplicate group',
      });

      expect(await groupModel.countDocuments()).toBe(0);
      expect(await groupMembershipModel.countDocuments()).toBe(0);
    });

    it('assigns leadership roles strictly by proposed array order; members beyond index 2 are MEMBER', async () => {
      const customerIds = await createCustomers(5);
      const request = await service.initiateCreation(
        { name: 'Coop Order', branchId, proposedMemberCustomerIds: customerIds },
        INITIATOR_ID,
      );
      await approveGroupCreation(request);

      const group = await groupModel.findOne({ name: 'Coop Order' }).exec();
      const members = await groupMembershipModel.find({ groupId: group!._id }).exec();

      const expectedRoles = [
        GroupMemberRole.GROUP_HEAD,
        GroupMemberRole.GROUP_HEAD_ASSISTANT,
        GroupMemberRole.COORDINATOR,
        GroupMemberRole.MEMBER,
        GroupMemberRole.MEMBER,
      ];
      customerIds.forEach((customerId, index) => {
        const membership = members.find((m) => m.customerId.toString() === customerId);
        expect(membership?.role).toBe(expectedRoles[index]);
        expect(membership?.leftAt).toBeNull();
      });
    });

    it('creates Group + every GroupMembership transactionally on approval', async () => {
      const { groupId, customerIds } = await createApprovedGroup(4);
      const group = await groupModel.findById(groupId).exec();
      expect(group?.status).toBe('ACTIVE');

      const members = await service.getActiveMembers(groupId);
      expect(members).toHaveLength(4);
      expect(members.map((m) => m.customerId.toString()).sort()).toEqual([...customerIds].sort());
    });
  });

  // ---------------------------------------------------------------------------
  // The DB partial unique indexes — bypassing the service entirely
  // ---------------------------------------------------------------------------

  describe('GroupMembershipSchema partial unique indexes (direct DB writes)', () => {
    it('blocks two active holders of the same leadership role in one group', async () => {
      const groupId = new Types.ObjectId();
      const customerA = await createCustomer();
      const customerB = await createCustomer();

      await groupMembershipModel.create({
        groupId,
        customerId: customerA,
        role: GroupMemberRole.GROUP_HEAD,
        joinedAt: new Date(),
        leftAt: null,
        addedBy: INITIATOR_ID,
      });

      await expect(
        groupMembershipModel.create({
          groupId,
          customerId: customerB,
          role: GroupMemberRole.GROUP_HEAD,
          joinedAt: new Date(),
          leftAt: null,
          addedBy: INITIATOR_ID,
        }),
      ).rejects.toThrow(/E11000|duplicate key/);
    });

    it('allows multiple active MEMBER rows in one group (no uniqueness constraint on MEMBER)', async () => {
      const groupId = new Types.ObjectId();
      const customerA = await createCustomer();
      const customerB = await createCustomer();

      await groupMembershipModel.create({
        groupId,
        customerId: customerA,
        role: GroupMemberRole.MEMBER,
        joinedAt: new Date(),
        leftAt: null,
        addedBy: INITIATOR_ID,
      });
      await expect(
        groupMembershipModel.create({
          groupId,
          customerId: customerB,
          role: GroupMemberRole.MEMBER,
          joinedAt: new Date(),
          leftAt: null,
          addedBy: INITIATOR_ID,
        }),
      ).resolves.toBeTruthy();
    });

    it('blocks two active memberships for the same (groupId, customerId)', async () => {
      const groupId = new Types.ObjectId();
      const customerId = await createCustomer();

      await groupMembershipModel.create({
        groupId,
        customerId,
        role: GroupMemberRole.MEMBER,
        joinedAt: new Date(),
        leftAt: null,
        addedBy: INITIATOR_ID,
      });

      await expect(
        groupMembershipModel.create({
          groupId,
          customerId,
          role: GroupMemberRole.MEMBER,
          joinedAt: new Date(),
          leftAt: null,
          addedBy: INITIATOR_ID,
        }),
      ).rejects.toThrow(/E11000|duplicate key/);
    });
  });

  // ---------------------------------------------------------------------------
  // Member addition
  // ---------------------------------------------------------------------------

  describe('initiateMemberAddition', () => {
    it('does not create a live GroupMembership until approved, and is not counted while pending', async () => {
      const { groupId } = await createApprovedGroup(3);
      const newCustomerId = await createCustomer();

      const addRequest = await service.initiateMemberAddition(
        groupId,
        { customerId: newCustomerId },
        INITIATOR_ID,
      );

      const activeMembersBefore = await service.getActiveMembers(groupId);
      expect(activeMembersBefore).toHaveLength(3);
      expect(activeMembersBefore.some((m) => m.customerId.toString() === newCustomerId)).toBe(
        false,
      );

      const eligibilityBefore = await service.isEligibleForLoanApplication(groupId);
      expect(eligibilityBefore.eligible).toBe(true); // pending addition doesn't affect this

      await approveMembershipRequest(addRequest);

      const activeMembersAfter = await service.getActiveMembers(groupId);
      expect(activeMembersAfter).toHaveLength(4);
      const added = activeMembersAfter.find((m) => m.customerId.toString() === newCustomerId);
      expect(added?.role).toBe(GroupMemberRole.MEMBER);
    });

    it('rejects adding a customer who already has an active membership', async () => {
      const { groupId, customerIds } = await createApprovedGroup(3);
      await expect(
        service.initiateMemberAddition(groupId, { customerId: customerIds[0]! }, INITIATOR_ID),
      ).rejects.toThrow(/already has an active membership/);
    });

    it('rejects adding a non-existent customer', async () => {
      const { groupId } = await createApprovedGroup(3);
      await expect(
        service.initiateMemberAddition(
          groupId,
          { customerId: new Types.ObjectId().toString() },
          INITIATOR_ID,
        ),
      ).rejects.toThrow(/does not exist/);
    });
  });

  // ---------------------------------------------------------------------------
  // Member removal
  // ---------------------------------------------------------------------------

  describe('initiateMemberRemoval', () => {
    it('is blocked when LoanStatusPort.hasPendingLoan returns true', async () => {
      const { groupId, customerIds } = await createApprovedGroup(3);
      loanStatusPortMock.hasPendingLoan.mockResolvedValueOnce(true);

      await expect(
        service.initiateMemberRemoval(groupId, customerIds[2]!, 'relocating', INITIATOR_ID),
      ).rejects.toThrow(/pending loan/);
      expect(loanStatusPortMock.hasPendingLoan).toHaveBeenCalledWith(customerIds[2]);
    });

    it('is allowed when LoanStatusPort.hasPendingLoan returns false', async () => {
      const { groupId, customerIds } = await createApprovedGroup(3);
      loanStatusPortMock.hasPendingLoan.mockResolvedValueOnce(false);

      const request = await service.initiateMemberRemoval(
        groupId,
        customerIds[2]!,
        'relocating',
        INITIATOR_ID,
      );
      expect(request).toBeDefined();
    });

    it('rejects removing a customer with no active membership', async () => {
      const { groupId } = await createApprovedGroup(3);
      await expect(
        service.initiateMemberRemoval(
          groupId,
          new Types.ObjectId().toString(),
          'n/a',
          INITIATOR_ID,
        ),
      ).rejects.toThrow(/no active membership/);
    });

    it('does not close the membership until approved', async () => {
      const { groupId, customerIds } = await createApprovedGroup(3);
      const request = await service.initiateMemberRemoval(
        groupId,
        customerIds[2]!,
        'relocating',
        INITIATOR_ID,
      );

      const stillActive = await groupMembershipModel
        .findOne({
          groupId: new Types.ObjectId(groupId),
          customerId: new Types.ObjectId(customerIds[2]),
          leftAt: null,
        })
        .exec();
      expect(stillActive).not.toBeNull();

      await approveMembershipRequest(request);

      const closed = await groupMembershipModel
        .findOne({
          groupId: new Types.ObjectId(groupId),
          customerId: new Types.ObjectId(customerIds[2]),
        })
        .exec();
      expect(closed?.leftAt).not.toBeNull();
      expect(closed?.removalReason).toBe('relocating');
    });

    it('removing a leadership-role holder leaves the role vacant with no auto-promotion, and does not throw', async () => {
      const { groupId, customerIds } = await createApprovedGroup(3);
      const headCustomerId = customerIds[0]!; // index 0 == GROUP_HEAD

      const request = await service.initiateMemberRemoval(
        groupId,
        headCustomerId,
        'stepping down',
        INITIATOR_ID,
      );
      await expect(approveMembershipRequest(request)).resolves.not.toThrow();

      const leadership = await service.getLeadership(groupId);
      expect(leadership.head).toBeUndefined();

      const activeMembers = await service.getActiveMembers(groupId);
      expect(activeMembers.some((m) => m.customerId.toString() === headCustomerId)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Leadership reassignment
  // ---------------------------------------------------------------------------

  describe('reassignLeadershipRole', () => {
    async function approveSingleStep(request: WorkflowRequestDocument): Promise<void> {
      await workflowEngineService.act({
        workflowRequestId: request._id.toString(),
        actor: APPROVE_GROUP_ACTOR,
        action: WorkflowStepAction.APPROVED,
      });
    }

    it('fills a vacant leadership role', async () => {
      const { groupId, customerIds } = await createApprovedGroup(3);
      const removeRequest = await service.initiateMemberRemoval(
        groupId,
        customerIds[0]!,
        'left',
        INITIATOR_ID,
      );
      await approveMembershipRequest(removeRequest);

      const newLeaderId = await createCustomer();
      const reassignRequest = await service.reassignLeadershipRole(
        groupId,
        GroupMemberRole.GROUP_HEAD,
        newLeaderId,
        ADMIN_ID,
      );
      await approveSingleStep(reassignRequest);

      const leadership = await service.getLeadership(groupId);
      expect(leadership.head?.customerId.toString()).toBe(newLeaderId);
    });

    it('promotes an existing active member, closing their old row and opening a new one', async () => {
      const { groupId, customerIds } = await createApprovedGroup(4); // 4th is a plain MEMBER
      const removeRequest = await service.initiateMemberRemoval(
        groupId,
        customerIds[1]!,
        'left',
        INITIATOR_ID,
      );
      await approveMembershipRequest(removeRequest);

      const plainMemberId = customerIds[3]!;
      const reassignRequest = await service.reassignLeadershipRole(
        groupId,
        GroupMemberRole.GROUP_HEAD_ASSISTANT,
        plainMemberId,
        ADMIN_ID,
      );
      await approveSingleStep(reassignRequest);

      const leadership = await service.getLeadership(groupId);
      expect(leadership.assistant?.customerId.toString()).toBe(plainMemberId);

      const memberships = await groupMembershipModel
        .find({
          groupId: new Types.ObjectId(groupId),
          customerId: new Types.ObjectId(plainMemberId),
        })
        .exec();
      expect(memberships).toHaveLength(2); // old MEMBER row (closed) + new GROUP_HEAD_ASSISTANT row
      const closedRow = memberships.find((m) => m.role === GroupMemberRole.MEMBER);
      expect(closedRow?.leftAt).not.toBeNull();
      const openRow = memberships.find((m) => m.role === GroupMemberRole.GROUP_HEAD_ASSISTANT);
      expect(openRow?.leftAt).toBeNull();
    });

    it('is blocked at initiation when the role is already actively held', async () => {
      const { groupId } = await createApprovedGroup(3);
      const newLeaderId = await createCustomer();
      await expect(
        service.reassignLeadershipRole(groupId, GroupMemberRole.GROUP_HEAD, newLeaderId, ADMIN_ID),
      ).rejects.toThrow(/already has an active/);
    });

    it('rejects MEMBER as a role — only leadership roles are reassignable this way', async () => {
      const { groupId } = await createApprovedGroup(3);
      const newLeaderId = await createCustomer();
      await expect(
        service.reassignLeadershipRole(groupId, GroupMemberRole.MEMBER, newLeaderId, ADMIN_ID),
      ).rejects.toThrow(/not a leadership role/);
    });
  });

  // ---------------------------------------------------------------------------
  // Eligibility & queries
  // ---------------------------------------------------------------------------

  describe('isEligibleForLoanApplication', () => {
    it('is eligible when all active members are KYC-verified and count >= 3', async () => {
      const { groupId } = await createApprovedGroup(3, KycStatus.VERIFIED);
      const result = await service.isEligibleForLoanApplication(groupId);
      expect(result).toEqual({ eligible: true, ineligibleMembers: [] });
    });

    it('flags per-member KYC-incomplete reasons', async () => {
      const verifiedIds = await createCustomers(2, KycStatus.VERIFIED);
      const incompleteId = await createCustomer(KycStatus.INCOMPLETE);
      const allIds = [...verifiedIds, incompleteId];
      const request = await service.initiateCreation(
        { name: 'Coop Ineligible', branchId, proposedMemberCustomerIds: allIds },
        INITIATOR_ID,
      );
      await approveGroupCreation(request);
      const group = await groupModel.findOne({ name: 'Coop Ineligible' }).exec();

      const result = await service.isEligibleForLoanApplication(group!._id.toString());
      expect(result.eligible).toBe(false);
      expect(result.ineligibleMembers).toEqual([
        { customerId: incompleteId, reason: 'KYC not complete' },
      ]);
    });

    it('flags a group-level reason when active members have dropped below 3', async () => {
      const { groupId, customerIds } = await createApprovedGroup(3);
      const removeRequest = await service.initiateMemberRemoval(
        groupId,
        customerIds[2]!,
        'left',
        INITIATOR_ID,
      );
      await approveMembershipRequest(removeRequest);

      const result = await service.isEligibleForLoanApplication(groupId);
      expect(result.eligible).toBe(false);
      expect(result.ineligibleMembers).toEqual([
        { customerId: null, reason: 'Group has only 2 active member(s) — minimum 3 required' },
      ]);
    });
  });

  describe('getLeadership', () => {
    it('returns undefined for a vacant role rather than throwing', async () => {
      const { groupId, customerIds } = await createApprovedGroup(3);
      const removeRequest = await service.initiateMemberRemoval(
        groupId,
        customerIds[1]!,
        'left',
        INITIATOR_ID,
      );
      await approveMembershipRequest(removeRequest);

      const leadership = await service.getLeadership(groupId);
      expect(leadership.head).toBeDefined();
      expect(leadership.assistant).toBeUndefined();
      expect(leadership.coordinator).toBeDefined();
    });

    it('resolves all three roles when fully staffed', async () => {
      const { groupId, customerIds } = await createApprovedGroup(3);
      const leadership = await service.getLeadership(groupId);
      expect(leadership.head?.customerId.toString()).toBe(customerIds[0]);
      expect(leadership.assistant?.customerId.toString()).toBe(customerIds[1]);
      expect(leadership.coordinator?.customerId.toString()).toBe(customerIds[2]);
    });
  });
});
