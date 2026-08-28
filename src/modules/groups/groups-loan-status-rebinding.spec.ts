import { randomBytes } from 'node:crypto';

import { ConflictException } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model, Types } from 'mongoose';

import { __resetPiiEncryptionKeyCache } from '../../common/crypto/pii-encryption';
import { CustomerStatus, KycStatus } from '../../common/enums/customer.enums';
import { MemberLoanAccountStatus } from '../../common/enums/loan.enums';
import { WorkflowEntityType, WorkflowStepAction } from '../../common/enums/workflow.enums';
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
  WorkflowRequestDocument,
  WorkflowRequest,
  WorkflowRequestSchema,
} from '../../platform/workflow-engine/schemas/workflow-request.schema';
import { WorkflowEngineService } from '../../platform/workflow-engine/workflow-engine.service';
import { Branch, BranchDocument, BranchSchema } from '../branches/schemas/branch.schema';
import { Staff, StaffSchema } from '../identity/schemas/staff.schema';
import { CustomerService } from '../customers/customer.service';
import { Customer, CustomerDocument, CustomerSchema } from '../customers/schemas/customer.schema';
import { KycRecord, KycRecordSchema } from '../customers/schemas/kyc-record.schema';
import { BvnVerificationPreview, BvnVerificationPreviewSchema } from '../customers/schemas/bvn-verification-preview.schema';
import {
  MemberLoanAccount,
  MemberLoanAccountDocument,
  MemberLoanAccountSchema,
} from '../loans/schemas/member-loan-account.schema';
import { GroupsService } from './groups.service';
import { RealLoanStatusPort } from './loan-status/real-loan-status.port';
import { LOAN_STATUS_PORT } from './interfaces/loan-status-port.interface';
import {
  GroupMembership,
  GroupMembershipDocument,
  GroupMembershipSchema,
} from './schemas/group-membership.schema';
import { Group, GroupDocument, GroupSchema } from './schemas/group.schema';

/**
 * Phase 8's required end-to-end proof that rebinding LOAN_STATUS_PORT to
 * RealLoanStatusPort actually takes effect through GroupsService — not just a
 * unit test of the port in isolation. This mirrors groups.module.ts's real
 * wiring exactly (RealLoanStatusPort reading the real MemberLoanAccount
 * collection), the one thing groups.service.spec.ts's jest-mocked
 * LOAN_STATUS_PORT can't prove. See PHASE_8_NOTES.md.
 */
describe('GroupsService — LoanStatusPort rebinding (Phase 8)', () => {
  const mongo = new InMemoryMongo();

  let moduleRef: TestingModule;
  let service: GroupsService;
  let workflowEngineService: WorkflowEngineService;
  let groupModel: Model<GroupDocument>;
  let groupMembershipModel: Model<GroupMembershipDocument>;
  let customerModel: Model<CustomerDocument>;
  let branchModel: Model<BranchDocument>;
  let memberLoanAccountModel: Model<MemberLoanAccountDocument>;
  let branchId: string;

  const INITIATOR_ID = new Types.ObjectId().toString();
  const REVIEWER_ID = new Types.ObjectId().toString();
  const APPROVER_ID = new Types.ObjectId().toString();

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
          { name: MemberLoanAccount.name, schema: MemberLoanAccountSchema },
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
        // The real binding — exactly what groups.module.ts now wires up in
        // production, not a jest mock.
        RealLoanStatusPort,
        { provide: LOAN_STATUS_PORT, useExisting: RealLoanStatusPort },
      ],
    }).compile();

    service = moduleRef.get(GroupsService);
    workflowEngineService = moduleRef.get(WorkflowEngineService);
    groupModel = moduleRef.get(getModelToken(Group.name));
    groupMembershipModel = moduleRef.get(getModelToken(GroupMembership.name));
    customerModel = moduleRef.get(getModelToken(Customer.name));
    branchModel = moduleRef.get(getModelToken(Branch.name));
    memberLoanAccountModel = moduleRef.get(getModelToken(MemberLoanAccount.name));

    await moduleRef.init();
  }, 60_000);

  beforeEach(async () => {
    const branch = await branchModel.create({
      name: 'Main',
      code: `BR${Date.now()}${Math.random()}`,
      active: true,
    });
    branchId = branch._id.toString();
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

  let customerCounter = 0;
  async function createCustomer(): Promise<string> {
    customerCounter += 1;
    const customer = await customerModel.create({
      firstName: 'Test',
      lastName: `Customer${customerCounter}`,
      phoneNumber: `0800${customerCounter}${Date.now()}`.slice(0, 15),
      branchId,
      status: CustomerStatus.ACTIVE,
      kycStatus: KycStatus.VERIFIED,
      createdBy: INITIATOR_ID,
    });
    return customer._id.toString();
  }

  async function createCustomers(n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      ids.push(await createCustomer());
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

  async function createApprovedGroup(n = 3): Promise<{ groupId: string; customerIds: string[] }> {
    const customerIds = await createCustomers(n);
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

  async function createMemberLoanAccount(
    customerId: string,
    status: MemberLoanAccountStatus,
  ): Promise<void> {
    await memberLoanAccountModel.create({
      loanId: new Types.ObjectId(),
      customerId: new Types.ObjectId(customerId),
      principalAmountKobo: 100_000,
      disbursementChannel: 'TRANSFER',
      schedule: [],
      outstandingBalanceKobo: null,
      status,
    });
  }

  async function removeMemberAndApprove(
    groupId: string,
    customerId: string,
  ): Promise<WorkflowRequestDocument> {
    const request = await service.initiateMemberRemoval(
      groupId,
      customerId,
      'testing rebinding',
      INITIATOR_ID,
    );
    await workflowEngineService.act({
      workflowRequestId: request._id.toString(),
      actor: REVIEW_MEMBERSHIP_ACTOR,
      action: WorkflowStepAction.APPROVED,
    });
    return workflowEngineService.act({
      workflowRequestId: request._id.toString(),
      actor: APPROVE_MEMBERSHIP_ACTOR,
      action: WorkflowStepAction.APPROVED,
    });
  }

  it.each([MemberLoanAccountStatus.PENDING, MemberLoanAccountStatus.ACTIVE])(
    'blocks initiateMemberRemoval, end-to-end, when the real MemberLoanAccount collection has a %s loan for that customer',
    async (status) => {
      const { groupId, customerIds } = await createApprovedGroup(4);
      const [target] = customerIds;
      await createMemberLoanAccount(target!, status);

      await expect(
        service.initiateMemberRemoval(groupId, target!, 'trying to remove', INITIATOR_ID),
      ).rejects.toThrow(ConflictException);

      // Never even reached a WorkflowRequest — the membership is still active.
      const stillActive = await groupMembershipModel.exists({
        groupId: new Types.ObjectId(groupId),
        customerId: new Types.ObjectId(target!),
        leftAt: null,
      });
      expect(stillActive).toBeTruthy();
    },
  );

  it.each([MemberLoanAccountStatus.CLOSED, MemberLoanAccountStatus.DEFAULTED])(
    'allows initiateMemberRemoval, end-to-end, when the real MemberLoanAccount collection only has a %s loan for that customer',
    async (status) => {
      const { groupId, customerIds } = await createApprovedGroup(4);
      const [target] = customerIds;
      await createMemberLoanAccount(target!, status);

      const request = await removeMemberAndApprove(groupId, target!);
      expect(request.status).toBe('APPROVED');

      const stillActive = await groupMembershipModel.exists({
        groupId: new Types.ObjectId(groupId),
        customerId: new Types.ObjectId(target!),
        leftAt: null,
      });
      expect(stillActive).toBeFalsy();
    },
  );

  it('allows initiateMemberRemoval, end-to-end, when the customer has no MemberLoanAccount at all', async () => {
    const { groupId, customerIds } = await createApprovedGroup(4);
    const [target] = customerIds;

    const request = await removeMemberAndApprove(groupId, target!);
    expect(request.status).toBe('APPROVED');
  });
});
