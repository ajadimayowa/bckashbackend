import { randomBytes } from 'node:crypto';

import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model, Types } from 'mongoose';

import { __resetPiiEncryptionKeyCache } from '../../common/crypto/pii-encryption';
import { GroupMemberRole, GroupStatus } from '../../common/enums/group.enums';
import { CustomerStatus, KycStatus } from '../../common/enums/customer.enums';
import { StaffRole } from '../../common/enums/identity.enums';
import { WorkflowEntityType, WorkflowStatus, WorkflowStepAction } from '../../common/enums/workflow.enums';
import { InMemoryMongo } from '../../test-utils/in-memory-mongo';
import { testAwsConfigModule } from '../../test-utils/test-aws-config.module';
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
import { Staff, StaffSchema } from '../identity/schemas/staff.schema';
import { CustomerService } from '../customers/customer.service';
import { Customer, CustomerDocument, CustomerSchema } from '../customers/schemas/customer.schema';
import { KycRecord, KycRecordSchema } from '../customers/schemas/kyc-record.schema';
import { BvnVerificationPreview, BvnVerificationPreviewSchema } from '../customers/schemas/bvn-verification-preview.schema';
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
        // CustomerService now needs a global ConfigService (added for
        // CUSTOMER_ENFORCE_UNIQUE_PHONE — see customer.service.ts's own
        // constructor) — reused here the same way loans.service.spec.ts
        // already does, for CustomerService's own S3_ADAPTER dependency.
        await testAwsConfigModule(),
        MongooseModule.forRoot(mongo.getUri()),
        MongooseModule.forFeature([
          { name: Group.name, schema: GroupSchema },
          { name: GroupMembership.name, schema: GroupMembershipSchema },
          { name: Branch.name, schema: BranchSchema },
          { name: Staff.name, schema: StaffSchema },
          { name: Customer.name, schema: CustomerSchema },
          { name: KycRecord.name, schema: KycRecordSchema },
          { name: BvnVerificationPreview.name, schema: BvnVerificationPreviewSchema },
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
    it('persists the optional intake fields (proposedLeaderName/meetingDay/meetingLocation/expectedMemberCount) through to the created Group', async () => {
      const customerIds = await createCustomers(3);
      const name = `Intake-${Date.now()}`;
      const request = await service.initiateCreation(
        {
          name,
          branchId,
          proposedMemberCustomerIds: customerIds,
          proposedLeaderName: 'Alhaja Aminat',
          meetingDay: 'Wednesday',
          meetingLocation: 'Oshodi Market',
          expectedMemberCount: 12,
        },
        INITIATOR_ID,
      );
      await approveGroupCreation(request);

      const group = await groupModel.findOne({ name }).exec();
      expect(group).toMatchObject({
        proposedLeaderName: 'Alhaja Aminat',
        meetingDay: 'Wednesday',
        meetingLocation: 'Oshodi Market',
        expectedMemberCount: 12,
      });
    });

    it('leaves the optional intake fields null when omitted', async () => {
      const { groupId } = await createApprovedGroup(3);
      const group = await groupModel.findById(groupId).exec();
      expect(group).toMatchObject({
        proposedLeaderName: null,
        meetingDay: null,
        meetingLocation: null,
        expectedMemberCount: null,
      });
    });

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

      // A pending addition DOES affect this now — see "a group goes PENDING
      // while a member addition is under review" describe block below for
      // the full behavior; this test stays focused on membership itself.
      const eligibilityBefore = await service.isEligibleForLoanApplication(groupId);
      expect(eligibilityBefore.eligible).toBe(false);

      await approveMembershipRequest(addRequest);

      const activeMembersAfter = await service.getActiveMembers(groupId);
      expect(activeMembersAfter).toHaveLength(4);
      const added = activeMembersAfter.find((m) => m.customerId.toString() === newCustomerId);
      expect(added?.role).toBe(GroupMemberRole.MEMBER);

      // Eligible again now that the group is back to ACTIVE.
      const eligibilityAfter = await service.isEligibleForLoanApplication(groupId);
      expect(eligibilityAfter.eligible).toBe(true);
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

    it('is blocked when the customer has a pending/active loan with another group (LoanStatusPort.hasPendingLoan)', async () => {
      const { groupId } = await createApprovedGroup(3);
      const newCustomerId = await createCustomer();
      loanStatusPortMock.hasPendingLoan.mockResolvedValueOnce(true);

      await expect(
        service.initiateMemberAddition(groupId, { customerId: newCustomerId }, INITIATOR_ID),
      ).rejects.toThrow(/pending\/active loan with another group/);
      expect(loanStatusPortMock.hasPendingLoan).toHaveBeenCalledWith(newCustomerId);
    });

    it('is allowed when LoanStatusPort.hasPendingLoan returns false', async () => {
      const { groupId } = await createApprovedGroup(3);
      const newCustomerId = await createCustomer();
      loanStatusPortMock.hasPendingLoan.mockResolvedValueOnce(false);

      const request = await service.initiateMemberAddition(
        groupId,
        { customerId: newCustomerId },
        INITIATOR_ID,
      );
      expect(request).toBeDefined();
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

  describe('edit privilege (requestEditPrivilege / decideEditPrivilege / updateGroupDetails)', () => {
    it('lets the creator request, an approver grant, and the creator then update the group intake details — consuming the privilege', async () => {
      const { groupId } = await createApprovedGroup(3);

      const requested = await service.requestEditPrivilege(groupId, 'Expected member count was wrong', INITIATOR_ID);
      expect(requested.editPrivilege.status).toBe('PENDING');

      const granted = await service.decideEditPrivilege(groupId, true, 'looks right', ADMIN_ID);
      expect(granted.editPrivilege.status).toBe('GRANTED');
      expect(granted.editPrivilege.decisionComment).toBe('looks right');

      const updated = await service.updateGroupDetails(groupId, INITIATOR_ID, { expectedMemberCount: 9 });
      expect(updated.expectedMemberCount).toBe(9);
      // Consumed — a fresh request is required for any further edit.
      expect(updated.editPrivilege.status).toBe('NONE');
    });

    it('rejects a request from anyone other than the group creator', async () => {
      const { groupId } = await createApprovedGroup(3);
      await expect(service.requestEditPrivilege(groupId, 'reason', ADMIN_ID)).rejects.toThrow();
    });

    it('rejects a second request while one is already pending', async () => {
      const { groupId } = await createApprovedGroup(3);
      await service.requestEditPrivilege(groupId, 'first', INITIATOR_ID);
      await expect(service.requestEditPrivilege(groupId, 'second', INITIATOR_ID)).rejects.toThrow();
    });

    it('rejects updateGroupDetails when no privilege has been granted', async () => {
      const { groupId } = await createApprovedGroup(3);
      await expect(
        service.updateGroupDetails(groupId, INITIATOR_ID, { expectedMemberCount: 9 }),
      ).rejects.toThrow();
    });

    it('rejects deciding when there is no pending request', async () => {
      const { groupId } = await createApprovedGroup(3);
      await expect(service.decideEditPrivilege(groupId, true, undefined, ADMIN_ID)).rejects.toThrow();
    });

    it('records a rejection with its comment, leaving the creator unable to update', async () => {
      const { groupId } = await createApprovedGroup(3);
      await service.requestEditPrivilege(groupId, 'reason', INITIATOR_ID);
      const rejected = await service.decideEditPrivilege(groupId, false, 'not needed', ADMIN_ID);
      expect(rejected.editPrivilege.status).toBe('REJECTED');
      await expect(
        service.updateGroupDetails(groupId, INITIATOR_ID, { expectedMemberCount: 9 }),
      ).rejects.toThrow();
    });
  });

  describe('findAllForActor — role-scoped reads (mirrors CustomerService.findAllForActor)', () => {
    it('ADMIN sees every group across branches; a MANAGER only sees their own branch; a MARKETER only sees groups they created', async () => {
      const branchA = branchId;
      const branchBDoc = await branchModel.create({
        name: 'Branch B',
        code: `BRB${Date.now()}${Math.random()}`,
        active: true,
      });
      const branchB = branchBDoc._id.toString();

      const marketerA = new Types.ObjectId().toString();
      const marketerB = new Types.ObjectId().toString();

      const customersA = await createCustomers(3);
      const groupARequest = await service.initiateCreation(
        { name: `A-${Date.now()}`, branchId: branchA, proposedMemberCustomerIds: customersA },
        marketerA,
      );
      await approveGroupCreation(groupARequest);

      const customersB = await createCustomers(3);
      const groupBRequest = await service.initiateCreation(
        { name: `B-${Date.now()}`, branchId: branchB, proposedMemberCustomerIds: customersB },
        marketerB,
      );
      await approveGroupCreation(groupBRequest);

      const adminView = await service.findAllForActor(
        {},
        { staffId: ADMIN_ID, role: StaffRole.ADMIN },
      );
      expect(adminView.length).toBe(2);

      const managerView = await service.findAllForActor(
        {},
        { staffId: new Types.ObjectId().toString(), role: StaffRole.MANAGER, branchId: branchA },
      );
      expect(managerView).toHaveLength(1);
      expect(managerView[0]!.branchId.toString()).toBe(branchA);

      const managerWithNoBranch = await service.findAllForActor(
        {},
        { staffId: new Types.ObjectId().toString(), role: StaffRole.MANAGER },
      );
      expect(managerWithNoBranch).toEqual([]);

      const marketerAView = await service.findAllForActor(
        {},
        { staffId: marketerA, role: StaffRole.MARKETER },
      );
      expect(marketerAView).toHaveLength(1);
      expect(marketerAView[0]!.createdBy.toString()).toBe(marketerA);

      const marketerBView = await service.findAllForActor(
        {},
        { staffId: marketerB, role: StaffRole.MARKETER },
      );
      expect(marketerBView).toHaveLength(1);
      expect(marketerBView[0]!.createdBy.toString()).toBe(marketerB);
    });
  });

  describe('reviseAndResubmit', () => {
    it('revises a REJECTED proposal (e.g. swapping out a member) and resends it through a fresh review cycle', async () => {
      const members = await createCustomers(3);
      const replacement = await createCustomer();
      const name = `Revise-${Date.now()}`;

      const request = await service.initiateCreation(
        { name, branchId, proposedMemberCustomerIds: members },
        INITIATOR_ID,
      );
      await workflowEngineService.act({
        workflowRequestId: request._id.toString(),
        actor: REVIEW_GROUP_ACTOR,
        action: WorkflowStepAction.REJECTED,
        comment: 'one of these members withdrew',
      });

      const revisedMembers = [members[0]!, members[1]!, replacement];
      const resubmitted = await service.reviseAndResubmit(request._id.toString(), INITIATOR_ID, {
        name,
        branchId,
        proposedMemberCustomerIds: revisedMembers,
      });

      expect(resubmitted.status).toBe(WorkflowStatus.PENDING_REVIEW);
      expect(resubmitted.currentStepIndex).toBe(0);
      const latestPayload = resubmitted.payloadHistory[resubmitted.payloadHistory.length - 1]?.payload as {
        proposedMemberCustomerIds: string[];
      };
      expect(latestPayload.proposedMemberCustomerIds).toEqual(revisedMembers);

      await workflowEngineService.act({
        workflowRequestId: resubmitted._id.toString(),
        actor: REVIEW_GROUP_ACTOR,
        action: WorkflowStepAction.APPROVED,
      });
      await workflowEngineService.act({
        workflowRequestId: resubmitted._id.toString(),
        actor: APPROVE_GROUP_ACTOR,
        action: WorkflowStepAction.APPROVED,
      });

      const created = await groupModel.findOne({ name }).exec();
      expect(created).not.toBeNull();
      const memberships = await groupMembershipModel.find({ groupId: created!._id }).exec();
      expect(memberships.map((m) => m.customerId.toString()).sort()).toEqual(revisedMembers.sort());
    });

    it('re-validates on resubmission — fewer than 3 members is still rejected', async () => {
      const members = await createCustomers(3);
      const name = `Revise2-${Date.now()}`;
      const request = await service.initiateCreation(
        { name, branchId, proposedMemberCustomerIds: members },
        INITIATOR_ID,
      );
      await workflowEngineService.act({
        workflowRequestId: request._id.toString(),
        actor: REVIEW_GROUP_ACTOR,
        action: WorkflowStepAction.REJECTED,
        comment: 'nope',
      });

      await expect(
        service.reviseAndResubmit(request._id.toString(), INITIATOR_ID, {
          name,
          branchId,
          proposedMemberCustomerIds: members.slice(0, 2),
        }),
      ).rejects.toThrow(/at least 3/);
    });
  });

  describe('updateProposal', () => {
    it("edits a still-untouched PENDING_REVIEW proposal's details without disturbing the review chain", async () => {
      const members = await createCustomers(3);
      const name = `Edit-${Date.now()}`;

      const request = await service.initiateCreation(
        { name, branchId, proposedMemberCustomerIds: members },
        INITIATOR_ID,
      );

      const newName = `${name}-fixed`;
      const updated = await service.updateProposal(request._id.toString(), INITIATOR_ID, {
        name: newName,
        branchId,
        proposedMemberCustomerIds: members,
        expectedMemberCount: 12,
      });

      expect(updated.status).toBe(WorkflowStatus.PENDING_REVIEW);
      expect(updated.currentStepIndex).toBe(0);
      const latestPayload = updated.payloadHistory[updated.payloadHistory.length - 1]?.payload as {
        name: string;
        expectedMemberCount?: number;
      };
      expect(latestPayload.name).toBe(newName);
      expect(latestPayload.expectedMemberCount).toBe(12);

      // still fully reviewable/approvable afterwards
      await workflowEngineService.act({
        workflowRequestId: updated._id.toString(),
        actor: REVIEW_GROUP_ACTOR,
        action: WorkflowStepAction.APPROVED,
      });
      await workflowEngineService.act({
        workflowRequestId: updated._id.toString(),
        actor: APPROVE_GROUP_ACTOR,
        action: WorkflowStepAction.APPROVED,
      });
      const created = await groupModel.findOne({ name: newName }).exec();
      expect(created).not.toBeNull();
    });

    it('rejects editing once the proposal has been reviewed (no longer PENDING_REVIEW)', async () => {
      const members = await createCustomers(3);
      const name = `Edit2-${Date.now()}`;
      const request = await service.initiateCreation(
        { name, branchId, proposedMemberCustomerIds: members },
        INITIATOR_ID,
      );
      await workflowEngineService.act({
        workflowRequestId: request._id.toString(),
        actor: REVIEW_GROUP_ACTOR,
        action: WorkflowStepAction.APPROVED,
      });

      await expect(
        service.updateProposal(request._id.toString(), INITIATOR_ID, {
          name,
          branchId,
          proposedMemberCustomerIds: members,
        }),
      ).rejects.toThrow(/PENDING_REVIEW/);
    });

    it('re-validates on edit — fewer than 3 members is still rejected', async () => {
      const members = await createCustomers(3);
      const name = `Edit3-${Date.now()}`;
      const request = await service.initiateCreation(
        { name, branchId, proposedMemberCustomerIds: members },
        INITIATOR_ID,
      );

      await expect(
        service.updateProposal(request._id.toString(), INITIATOR_ID, {
          name,
          branchId,
          proposedMemberCustomerIds: members.slice(0, 2),
        }),
      ).rejects.toThrow(/at least 3/);
    });
  });

  describe('deleteProposal', () => {
    it('deletes the WorkflowRequest and hard-deletes every still-draft proposed member, leaving an already-ACTIVE one untouched', async () => {
      const preExistingActiveMembers = await createCustomers(2);
      const draftMember = await customerModel.create({
        firstName: 'Draft',
        lastName: 'Member',
        phoneNumber: `0802${Date.now()}`.slice(0, 15),
        branchId,
        status: CustomerStatus.PENDING_APPROVAL,
        kycStatus: KycStatus.INCOMPLETE,
        createdBy: INITIATOR_ID,
      });
      const memberIds = [...preExistingActiveMembers, draftMember._id.toString()];

      const name = `DeleteMe-${Date.now()}`;
      const request = await service.initiateCreation(
        { name, branchId, proposedMemberCustomerIds: memberIds },
        INITIATOR_ID,
      );

      await service.deleteProposal(request._id.toString(), INITIATOR_ID);

      await expect(workflowEngineService.getById(request._id.toString())).rejects.toThrow(NotFoundException);
      expect(await customerModel.findById(draftMember._id).exec()).toBeNull();
      for (const activeId of preExistingActiveMembers) {
        expect(await customerModel.findById(activeId).exec()).not.toBeNull();
      }
    });

    it('only the initiator may delete their own proposal', async () => {
      const members = await createCustomers(3);
      const name = `DeleteMe2-${Date.now()}`;
      const request = await service.initiateCreation(
        { name, branchId, proposedMemberCustomerIds: members },
        INITIATOR_ID,
      );

      await expect(service.deleteProposal(request._id.toString(), 'someone-else')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('rejects deleting a proposal that has already advanced past PENDING_REVIEW', async () => {
      const members = await createCustomers(3);
      const name = `DeleteMe3-${Date.now()}`;
      const request = await service.initiateCreation(
        { name, branchId, proposedMemberCustomerIds: members },
        INITIATOR_ID,
      );
      await workflowEngineService.act({
        workflowRequestId: request._id.toString(),
        actor: REVIEW_GROUP_ACTOR,
        action: WorkflowStepAction.APPROVED,
      });

      await expect(service.deleteProposal(request._id.toString(), INITIATOR_ID)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('pre-approval validator — every proposed member must be ACTIVE before the group is approved', () => {
    it('blocks the final approval (leaving nothing created) when a member is not yet an approved customer, but review still passes through', async () => {
      const activeMembers = await createCustomers(2);
      const notYetApproved = await customerModel.create({
        firstName: 'Pending',
        lastName: 'Member',
        phoneNumber: `0801${Date.now()}`.slice(0, 15),
        branchId,
        status: CustomerStatus.PENDING_APPROVAL,
        kycStatus: KycStatus.INCOMPLETE,
        createdBy: INITIATOR_ID,
      });
      const memberIds = [...activeMembers, notYetApproved._id.toString()];

      const name = `Gated-${Date.now()}`;
      const request = await service.initiateCreation(
        { name, branchId, proposedMemberCustomerIds: memberIds },
        INITIATOR_ID,
      );

      // Review step is unaffected — the validator only runs on the final step.
      await workflowEngineService.act({
        workflowRequestId: request._id.toString(),
        actor: REVIEW_GROUP_ACTOR,
        action: WorkflowStepAction.APPROVED,
      });

      await expect(
        workflowEngineService.act({
          workflowRequestId: request._id.toString(),
          actor: APPROVE_GROUP_ACTOR,
          action: WorkflowStepAction.APPROVED,
        }),
      ).rejects.toThrow(/must be approved/);

      expect(await groupModel.findOne({ name }).exec()).toBeNull();

      // The blocked attempt never actually committed anything (the validator
      // threw before the write) — so the same approver can simply retry
      // once the flagged member is approved, and it now succeeds.
      await customerModel.updateOne({ _id: notYetApproved._id }, { $set: { status: CustomerStatus.ACTIVE } }).exec();
      await workflowEngineService.act({
        workflowRequestId: request._id.toString(),
        actor: APPROVE_GROUP_ACTOR,
        action: WorkflowStepAction.APPROVED,
      });
      expect(await groupModel.findOne({ name }).exec()).not.toBeNull();
    });
  });

  describe('pre-approval validator — a new member must be an approved customer before joining an existing group', () => {
    it('blocks the final approval (member never joins) while the customer is still pending, but review still passes through', async () => {
      const { groupId } = await createApprovedGroup(3);
      const notYetApproved = await customerModel.create({
        firstName: 'Pending',
        lastName: 'Newcomer',
        phoneNumber: `0802${Date.now()}`.slice(0, 15),
        branchId,
        status: CustomerStatus.PENDING_APPROVAL,
        kycStatus: KycStatus.INCOMPLETE,
        createdBy: INITIATOR_ID,
      });

      const addRequest = await service.initiateMemberAddition(
        groupId,
        { customerId: notYetApproved._id.toString() },
        INITIATOR_ID,
      );

      // Review step is unaffected — the validator only runs on the final step.
      await workflowEngineService.act({
        workflowRequestId: addRequest._id.toString(),
        actor: REVIEW_MEMBERSHIP_ACTOR,
        action: WorkflowStepAction.APPROVED,
      });

      await expect(
        workflowEngineService.act({
          workflowRequestId: addRequest._id.toString(),
          actor: APPROVE_MEMBERSHIP_ACTOR,
          action: WorkflowStepAction.APPROVED,
        }),
      ).rejects.toThrow(/must be approved/);

      const activeMembers = await service.getActiveMembers(groupId);
      expect(activeMembers.some((m) => m.customerId.toString() === notYetApproved._id.toString())).toBe(false);

      // Same retry story as GROUP/CREATE's own validator — nothing committed
      // on the blocked attempt, so approving the customer and retrying just works.
      await customerModel.updateOne({ _id: notYetApproved._id }, { $set: { status: CustomerStatus.ACTIVE } }).exec();
      await workflowEngineService.act({
        workflowRequestId: addRequest._id.toString(),
        actor: APPROVE_MEMBERSHIP_ACTOR,
        action: WorkflowStepAction.APPROVED,
      });

      const activeMembersAfter = await service.getActiveMembers(groupId);
      expect(activeMembersAfter.some((m) => m.customerId.toString() === notYetApproved._id.toString())).toBe(true);
    });
  });

  describe('a group goes PENDING while a member addition is under review', () => {
    it('flips to PENDING as soon as the addition is submitted, blocks other group writes, but stays readable', async () => {
      const { groupId } = await createApprovedGroup(3);
      const newCustomerId = await createCustomer();

      await service.initiateMemberAddition(groupId, { customerId: newCustomerId }, INITIATOR_ID);

      const group = await groupModel.findById(groupId).exec();
      expect(group?.status).toBe(GroupStatus.PENDING);

      // Still readable.
      const found = await service.findById(groupId);
      expect(found.status).toBe(GroupStatus.PENDING);

      // Locked for every other write.
      const otherCustomerId = await createCustomer();
      await expect(
        service.initiateMemberAddition(groupId, { customerId: otherCustomerId }, INITIATOR_ID),
      ).rejects.toThrow(/is PENDING, not ACTIVE/);

      // Not eligible for a loan while pending — gracefully, not a thrown error.
      const eligibility = await service.isEligibleForLoanApplication(groupId);
      expect(eligibility.eligible).toBe(false);
      expect(eligibility.ineligibleMembers.some((m) => /not ACTIVE/.test(m.reason))).toBe(true);
    });

    it('reverts to ACTIVE once the addition is approved', async () => {
      const { groupId } = await createApprovedGroup(3);
      const newCustomerId = await createCustomer();
      const addRequest = await service.initiateMemberAddition(groupId, { customerId: newCustomerId }, INITIATOR_ID);

      expect((await groupModel.findById(groupId).exec())?.status).toBe(GroupStatus.PENDING);

      await approveMembershipRequest(addRequest);

      expect((await groupModel.findById(groupId).exec())?.status).toBe(GroupStatus.ACTIVE);
    });

    it('reverts to ACTIVE once the addition is rejected', async () => {
      const { groupId } = await createApprovedGroup(3);
      const newCustomerId = await createCustomer();
      const addRequest = await service.initiateMemberAddition(groupId, { customerId: newCustomerId }, INITIATOR_ID);

      await workflowEngineService.act({
        workflowRequestId: addRequest._id.toString(),
        actor: REVIEW_MEMBERSHIP_ACTOR,
        action: WorkflowStepAction.REJECTED,
        comment: 'no',
      });

      expect((await groupModel.findById(groupId).exec())?.status).toBe(GroupStatus.ACTIVE);
    });

    it('reverts to ACTIVE if the maker cancels the addition', async () => {
      const { groupId } = await createApprovedGroup(3);
      const newCustomerId = await createCustomer();
      const addRequest = await service.initiateMemberAddition(groupId, { customerId: newCustomerId }, INITIATOR_ID);

      await workflowEngineService.cancel({ workflowRequestId: addRequest._id.toString(), actorId: INITIATOR_ID });

      expect((await groupModel.findById(groupId).exec())?.status).toBe(GroupStatus.ACTIVE);
    });

    it('reverts to ACTIVE if the maker deletes the (still PENDING_REVIEW) addition', async () => {
      const { groupId } = await createApprovedGroup(3);
      const newCustomerId = await createCustomer();
      const addRequest = await service.initiateMemberAddition(groupId, { customerId: newCustomerId }, INITIATOR_ID);

      await workflowEngineService.deleteRequest({
        workflowRequestId: addRequest._id.toString(),
        actorId: INITIATOR_ID,
      });

      expect((await groupModel.findById(groupId).exec())?.status).toBe(GroupStatus.ACTIVE);
    });
  });
});
