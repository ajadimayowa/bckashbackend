import { randomBytes } from 'node:crypto';

import { BadRequestException, ConflictException } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model, Types } from 'mongoose';

import { __resetPiiEncryptionKeyCache } from '../../common/crypto/pii-encryption';
import { CustomerStatus, KycStatus } from '../../common/enums/customer.enums';
import {
  FeeAppliesTo,
  FeeCalcType,
  FeeCategory,
  FeeTiming,
  InterestType,
  PenaltyFrequency,
} from '../../common/enums/loan-product.enums';
import {
  DisbursementChannel,
  DisbursementVerificationStatus,
  LoanStatus,
  MemberLoanAccountStatus,
} from '../../common/enums/loan.enums';
import { WorkflowEntityType, WorkflowStepAction } from '../../common/enums/workflow.enums';
import { InMemoryMongo } from '../../test-utils/in-memory-mongo';
import { testAwsConfigModule } from '../../test-utils/test-aws-config.module';
import { AuditModule } from '../../platform/audit/audit.module';
import { AuditLog, AuditLogDocument } from '../../platform/audit/schemas/audit-log.schema';
import { EncryptionService } from '../../platform/encryption/encryption.service';
import { BvnCallLogService } from '../../platform/integrations/bvn/bvn-call-log.service';
import { BvnProviderUnavailableException } from '../../platform/integrations/bvn/exceptions/bvn-provider-unavailable.exception';
import { BVN_VERIFICATION_ADAPTER } from '../../platform/integrations/bvn/interfaces/bvn-verification-adapter.interface';
import {
  MOCK_BVN_OTP,
  MockBvnVerificationAdapter,
} from '../../platform/integrations/bvn/mock-bvn-verification.adapter';
import {
  BvnCallLog,
  BvnCallLogSchema,
} from '../../platform/integrations/bvn/schemas/bvn-call-log.schema';
import { FaceComparisonCallLogService } from '../../platform/integrations/rekognition/face-comparison-call-log.service';
import { FACE_COMPARISON_ADAPTER } from '../../platform/integrations/rekognition/interfaces/face-comparison-adapter.interface';
import {
  MOCK_FACE_COMPARISON_FAIL_MARKER,
  MockRekognitionAdapter,
} from '../../platform/integrations/rekognition/mock-rekognition.adapter';
import {
  FaceComparisonCallLog,
  FaceComparisonCallLogSchema,
} from '../../platform/integrations/rekognition/schemas/face-comparison-call-log.schema';
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
import { BranchFundBalanceService } from '../branches/branch-fund-balance.service';
import {
  BranchFundBalance,
  BranchFundBalanceSchema,
} from '../branches/schemas/branch-fund-balance.schema';
import { Branch, BranchDocument, BranchSchema } from '../branches/schemas/branch.schema';
import { CustomerService } from '../customers/customer.service';
import { Customer, CustomerDocument, CustomerSchema } from '../customers/schemas/customer.schema';
import { KycRecord, KycRecordSchema } from '../customers/schemas/kyc-record.schema';
import {
  PendingBvnConsent,
  PendingBvnConsentSchema,
} from '../customers/schemas/pending-bvn-consent.schema';
import { calculateFlatInterestSchedule } from '../loan-products/calculations';
import { CreateFeeDefinitionDto } from '../loan-products/dto/create-fee-definition.dto';
import { CreateLoanProductDto } from '../loan-products/dto/create-loan-product.dto';
import { FeeDefinitionsService } from '../loan-products/fee-definitions.service';
import { LoanProductsService, loanApprovalActionFor } from '../loan-products/loan-products.service';
import {
  FeeDefinition,
  FeeDefinitionDocument,
  FeeDefinitionSchema,
} from '../loan-products/schemas/fee-definition.schema';
import {
  LoanProduct,
  LoanProductDocument,
  LoanProductSchema,
} from '../loan-products/schemas/loan-product.schema';
import { GroupsService } from '../groups/groups.service';
import { LOAN_STATUS_PORT } from '../groups/interfaces/loan-status-port.interface';
import { GroupMembership, GroupMembershipSchema } from '../groups/schemas/group-membership.schema';
import { Group, GroupDocument, GroupSchema } from '../groups/schemas/group.schema';
import { StubBankTransferPort } from './bank-transfer/stub-bank-transfer.port';
import { FeePaymentsService } from './fee-payments.service';
import { BANK_TRANSFER_PORT } from './interfaces/bank-transfer-port.interface';
import { LEDGER_POSTING_PORT } from './interfaces/ledger-posting-port.interface';
import { NOTIFICATION_PORT } from './interfaces/notification-port.interface';
import { StubLedgerPostingPort } from './ledger/stub-ledger-posting.port';
import { LoanVerificationService } from './loan-verification.service';
import { LoansService } from './loans.service';
import { PendingNotificationLogPort } from './notifications/pending-notification-log.port';
import {
  PendingNotificationLog,
  PendingNotificationLogDocument,
  PendingNotificationLogSchema,
} from '../notifications/schemas/pending-notification-log.schema';
import {
  DisbursementVerification,
  DisbursementVerificationDocument,
  DisbursementVerificationSchema,
} from './schemas/disbursement-verification.schema';
import { FeePayment, FeePaymentSchema } from './schemas/fee-payment.schema';
import {
  MemberLoanAccount,
  MemberLoanAccountDocument,
  MemberLoanAccountSchema,
} from './schemas/member-loan-account.schema';
import { Loan, LoanDocument, LoanSchema } from './schemas/loan.schema';

describe('LoansService & LoanVerificationService', () => {
  const mongo = new InMemoryMongo();

  let moduleRef: TestingModule;
  let loansService: LoansService;
  let loanVerificationService: LoanVerificationService;
  let groupsService: GroupsService;
  let loanProductsService: LoanProductsService;
  let feeDefinitionsService: FeeDefinitionsService;
  let customerService: CustomerService;
  let workflowEngineService: WorkflowEngineService;
  let branchFundBalanceService: BranchFundBalanceService;
  let mockBvnAdapter: MockBvnVerificationAdapter;

  let loanModel: Model<LoanDocument>;
  let memberLoanAccountModel: Model<MemberLoanAccountDocument>;
  let disbursementVerificationModel: Model<DisbursementVerificationDocument>;
  let feePaymentModel: Model<import('./schemas/fee-payment.schema').FeePaymentDocument>;
  let groupModel: Model<GroupDocument>;
  let customerModel: Model<CustomerDocument>;
  let branchModel: Model<BranchDocument>;
  let loanProductModel: Model<LoanProductDocument>;
  let feeDefinitionModel: Model<FeeDefinitionDocument>;
  let workflowRequestModel: Model<WorkflowRequestDocument>;
  let branchFundBalanceModel: Model<
    import('../branches/schemas/branch-fund-balance.schema').BranchFundBalanceDocument
  >;
  let pendingNotificationLogModel: Model<PendingNotificationLogDocument>;
  let auditLogModel: Model<AuditLogDocument>;

  let branchId: string;

  const INITIATOR_ID = new Types.ObjectId().toString();
  const REVIEWER_ID = new Types.ObjectId().toString();
  const APPROVER_ID = new Types.ObjectId().toString();
  const LOAN_APPROVER_ID = new Types.ObjectId().toString();
  const ADMIN_ID = new Types.ObjectId().toString();

  const REVIEW_GROUP_ACTOR: ActingStaff = {
    staffId: REVIEWER_ID,
    capabilities: [reviewCapability(WorkflowEntityType.GROUP)],
  };
  const APPROVE_GROUP_ACTOR: ActingStaff = {
    staffId: APPROVER_ID,
    capabilities: [approveCapability(WorkflowEntityType.GROUP)],
  };
  const APPROVE_PRODUCT_ACTOR: ActingStaff = {
    staffId: APPROVER_ID,
    capabilities: [approveCapability(WorkflowEntityType.LOAN_PRODUCT)],
  };
  const APPROVE_FEE_ACTOR: ActingStaff = {
    staffId: APPROVER_ID,
    capabilities: [approveCapability(WorkflowEntityType.FEE_DEFINITION)],
  };
  const APPROVE_LOAN_ACTOR: ActingStaff = {
    staffId: LOAN_APPROVER_ID,
    capabilities: [approveCapability(WorkflowEntityType.LOAN)],
  };
  beforeAll(async () => {
    process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    __resetPiiEncryptionKeyCache();

    await mongo.start();

    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri()),
        MongooseModule.forFeature([
          { name: Loan.name, schema: LoanSchema },
          { name: MemberLoanAccount.name, schema: MemberLoanAccountSchema },
          { name: DisbursementVerification.name, schema: DisbursementVerificationSchema },
          { name: FeePayment.name, schema: FeePaymentSchema },
          { name: Group.name, schema: GroupSchema },
          { name: GroupMembership.name, schema: GroupMembershipSchema },
          { name: Branch.name, schema: BranchSchema },
          { name: BranchFundBalance.name, schema: BranchFundBalanceSchema },
          { name: Customer.name, schema: CustomerSchema },
          { name: KycRecord.name, schema: KycRecordSchema },
          { name: PendingBvnConsent.name, schema: PendingBvnConsentSchema },
          { name: BvnCallLog.name, schema: BvnCallLogSchema },
          { name: FaceComparisonCallLog.name, schema: FaceComparisonCallLogSchema },
          { name: LoanProduct.name, schema: LoanProductSchema },
          { name: FeeDefinition.name, schema: FeeDefinitionSchema },
          { name: WorkflowChainConfig.name, schema: WorkflowChainConfigSchema },
          { name: WorkflowRequest.name, schema: WorkflowRequestSchema },
          { name: PendingNotificationLog.name, schema: PendingNotificationLogSchema },
        ]),
        AuditModule,
        EventEmitterModule.forRoot(),
        await testAwsConfigModule(),
      ],
      providers: [
        LoansService,
        LoanVerificationService,
        FeePaymentsService,
        GroupsService,
        LoanProductsService,
        FeeDefinitionsService,
        CustomerService,
        WorkflowEngineService,
        BranchFundBalanceService,
        EncryptionService,
        BvnCallLogService,
        FaceComparisonCallLogService,
        MockBvnVerificationAdapter,
        MockS3Service,
        MockRekognitionAdapter,
        StubLedgerPostingPort,
        PendingNotificationLogPort,
        StubBankTransferPort,
        { provide: BVN_VERIFICATION_ADAPTER, useExisting: MockBvnVerificationAdapter },
        { provide: S3_ADAPTER, useExisting: MockS3Service },
        { provide: FACE_COMPARISON_ADAPTER, useExisting: MockRekognitionAdapter },
        { provide: LEDGER_POSTING_PORT, useExisting: StubLedgerPostingPort },
        { provide: NOTIFICATION_PORT, useExisting: PendingNotificationLogPort },
        { provide: BANK_TRANSFER_PORT, useExisting: StubBankTransferPort },
        // GroupsService's own LOAN_STATUS_PORT — irrelevant to raiseApplication
        // (which never calls hasPendingLoan), stubbed simply; the real
        // rebinding is proven separately in groups-loan-status-rebinding.spec.ts.
        { provide: LOAN_STATUS_PORT, useValue: { hasPendingLoan: () => Promise.resolve(false) } },
      ],
    }).compile();

    loansService = moduleRef.get(LoansService);
    loanVerificationService = moduleRef.get(LoanVerificationService);
    groupsService = moduleRef.get(GroupsService);
    loanProductsService = moduleRef.get(LoanProductsService);
    feeDefinitionsService = moduleRef.get(FeeDefinitionsService);
    customerService = moduleRef.get(CustomerService);
    workflowEngineService = moduleRef.get(WorkflowEngineService);
    branchFundBalanceService = moduleRef.get(BranchFundBalanceService);
    mockBvnAdapter = moduleRef.get(MockBvnVerificationAdapter);

    loanModel = moduleRef.get(getModelToken(Loan.name));
    memberLoanAccountModel = moduleRef.get(getModelToken(MemberLoanAccount.name));
    disbursementVerificationModel = moduleRef.get(getModelToken(DisbursementVerification.name));
    feePaymentModel = moduleRef.get(getModelToken(FeePayment.name));
    groupModel = moduleRef.get(getModelToken(Group.name));
    customerModel = moduleRef.get(getModelToken(Customer.name));
    branchModel = moduleRef.get(getModelToken(Branch.name));
    loanProductModel = moduleRef.get(getModelToken(LoanProduct.name));
    feeDefinitionModel = moduleRef.get(getModelToken(FeeDefinition.name));
    workflowRequestModel = moduleRef.get(getModelToken(WorkflowRequest.name));
    branchFundBalanceModel = moduleRef.get(getModelToken(BranchFundBalance.name));
    pendingNotificationLogModel = moduleRef.get(getModelToken(PendingNotificationLog.name));
    auditLogModel = moduleRef.get(getModelToken(AuditLog.name));

    await moduleRef.init();
  }, 60_000);

  beforeEach(async () => {
    const branch = await branchModel.create({
      name: 'Main',
      code: `BR${Date.now()}${Math.random()}`,
      active: true,
    });
    branchId = branch._id.toString();
    // Generously funded by default — tests that care about insufficient
    // funds explicitly under-fund instead.
    await branchFundBalanceModel.create({
      branchId: new Types.ObjectId(branchId),
      availableAmount: 1_000_000_000,
    });
  });

  afterEach(async () => {
    const collectionsToKeep = new Set(['workflow_chain_configs']);
    const connection = loanModel.db;
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

  /** For group-composition/eligibility-only tests — no KYC record at all. */
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

  /** Full BVN-consent + biometric-capture flow — needed for verification tests. */
  async function createVerifiedCustomerWithBiometrics(): Promise<string> {
    customerCounter += 1;
    const bvn = `${10_000_000_000 + customerCounter}`.slice(0, 11);
    const { pendingConsentId } = await customerService.startBvnConsent(bvn, INITIATOR_ID, branchId);
    const customer = await customerService.confirmBvnConsent(pendingConsentId, MOCK_BVN_OTP);
    await customerService.captureBiometric(
      customer._id.toString(),
      Buffer.from('biometric-image'),
      'image/jpeg',
      INITIATOR_ID,
    );
    return customer._id.toString();
  }

  async function createCustomers(
    n: number,
    factory: () => Promise<string> = createCustomer,
  ): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      ids.push(await factory());
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

  async function createApprovedGroup(
    factory: () => Promise<string> = createCustomer,
    n = 3,
  ): Promise<{ groupId: string; customerIds: string[] }> {
    const customerIds = await createCustomers(n, factory);
    const name = `Group-${Date.now()}-${Math.random()}`;
    const request = await groupsService.initiateCreation(
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

  function feeDto(overrides: Partial<CreateFeeDefinitionDto> = {}): CreateFeeDefinitionDto {
    return {
      name: `Fee-${Date.now()}-${Math.random()}`,
      category: FeeCategory.REGISTRATION,
      timing: FeeTiming.PRE_LOAN,
      calcType: FeeCalcType.FIXED,
      value: 500,
      appliesTo: FeeAppliesTo.PER_MEMBER,
      ...overrides,
    };
  }

  async function createApprovedFee(
    overrides: Partial<CreateFeeDefinitionDto> = {},
  ): Promise<string> {
    const dto = feeDto(overrides);
    const request = await feeDefinitionsService.initiateCreation(dto, INITIATOR_ID);
    await workflowEngineService.act({
      workflowRequestId: request._id.toString(),
      actor: APPROVE_FEE_ACTOR,
      action: WorkflowStepAction.APPROVED,
    });
    const created = await feeDefinitionModel.findOne({ name: dto.name }).exec();
    return created!._id.toString();
  }

  function productDto(overrides: Partial<CreateLoanProductDto> = {}): CreateLoanProductDto {
    return {
      name: `Product-${Date.now()}-${Math.random()}`,
      interestRate: 1_800,
      interestType: InterestType.FLAT,
      tenureOptions: [6, 12],
      minGroupSize: 3,
      feeIds: [],
      approvalChainSteps: [
        { order: 0, requiredCapability: approveCapability(WorkflowEntityType.LOAN) },
      ],
      penaltyRule: {
        calcType: FeeCalcType.FIXED,
        value: 1_000,
        gracePeriodDays: 5,
        frequency: PenaltyFrequency.ONE_TIME,
      },
      ...overrides,
    };
  }

  async function createApprovedProduct(
    overrides: Partial<CreateLoanProductDto> = {},
  ): Promise<LoanProductDocument> {
    const dto = productDto(overrides);
    const request = await loanProductsService.initiateCreation(dto, INITIATOR_ID);
    await workflowEngineService.act({
      workflowRequestId: request._id.toString(),
      actor: APPROVE_PRODUCT_ACTOR,
      action: WorkflowStepAction.APPROVED,
    });
    const created = await loanProductModel.findOne({ name: dto.name }).exec();
    return created!;
  }

  async function approveLoan(loanId: string): Promise<void> {
    const requests = await workflowRequestModel
      .find({ entityType: WorkflowEntityType.LOAN, entityId: loanId })
      .exec();
    const request = requests[0];
    if (!request) {
      throw new Error(`No LOAN WorkflowRequest found for loan ${loanId}`);
    }
    await workflowEngineService.act({
      workflowRequestId: request._id.toString(),
      actor: APPROVE_LOAN_ACTOR,
      action: WorkflowStepAction.APPROVED,
    });
  }

  /** Group of `n` verified-with-biometrics customers + an approved product sized to it, loan raised. */
  async function raiseAndApproveLoan(n = 3, productOverrides: Partial<CreateLoanProductDto> = {}) {
    const { groupId, customerIds } = await createApprovedGroup(
      createVerifiedCustomerWithBiometrics,
      n,
    );
    const product = await createApprovedProduct(productOverrides);
    const result = await loansService.raiseApplication(
      groupId,
      product._id.toString(),
      product.tenureOptions[0]!,
      customerIds.map((customerId) => ({
        customerId,
        requestedAmountKobo: 200_000,
        disbursementChannel: DisbursementChannel.TRANSFER,
      })),
      INITIATOR_ID,
    );
    await approveLoan(result.loan._id.toString());
    return { groupId, customerIds, product, loanId: result.loan._id.toString() };
  }

  async function passVerification(loanId: string, customerId: string): Promise<void> {
    await loanVerificationService.initiateMemberVerification(
      loanId,
      customerId,
      Buffer.from('live-image-ok'),
      INITIATOR_ID,
    );
  }

  // ---------------------------------------------------------------------------
  // raiseApplication
  // ---------------------------------------------------------------------------

  describe('raiseApplication', () => {
    it('rejects when the group is not loan-eligible, surfacing the specific ineligible members', async () => {
      const { groupId, customerIds } = await createApprovedGroup(
        () => createCustomer(KycStatus.INCOMPLETE),
        3,
      );
      const product = await createApprovedProduct();

      let caught: ConflictException | undefined;
      try {
        await loansService.raiseApplication(
          groupId,
          product._id.toString(),
          product.tenureOptions[0]!,
          customerIds.map((customerId) => ({
            customerId,
            requestedAmountKobo: 100_000,
            disbursementChannel: DisbursementChannel.TRANSFER,
          })),
          INITIATOR_ID,
        );
      } catch (error) {
        caught = error as ConflictException;
      }

      expect(caught).toBeInstanceOf(ConflictException);
      const response = caught?.getResponse() as { ineligibleMembers?: { reason: string }[] };
      expect(response.ineligibleMembers?.some((m) => m.reason === 'KYC not complete')).toBe(true);
    });

    it('rejects an out-of-range tenureMonths', async () => {
      const { groupId, customerIds } = await createApprovedGroup(createCustomer, 3);
      const product = await createApprovedProduct({ tenureOptions: [6, 12] });

      await expect(
        loansService.raiseApplication(
          groupId,
          product._id.toString(),
          99,
          customerIds.map((customerId) => ({
            customerId,
            requestedAmountKobo: 100_000,
            disbursementChannel: DisbursementChannel.TRANSFER,
          })),
          INITIATOR_ID,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('correctly computes cumulativeAmountKobo', async () => {
      const { groupId, customerIds } = await createApprovedGroup(createCustomer, 3);
      const product = await createApprovedProduct();

      const result = await loansService.raiseApplication(
        groupId,
        product._id.toString(),
        product.tenureOptions[0]!,
        [
          {
            customerId: customerIds[0]!,
            requestedAmountKobo: 100_000,
            disbursementChannel: DisbursementChannel.TRANSFER,
          },
          {
            customerId: customerIds[1]!,
            requestedAmountKobo: 150_000,
            disbursementChannel: DisbursementChannel.TRANSFER,
          },
          {
            customerId: customerIds[2]!,
            requestedAmountKobo: 75_000,
            disbursementChannel: DisbursementChannel.TRANSFER,
          },
        ],
        INITIATOR_ID,
      );

      expect(result.loan.cumulativeAmountKobo).toBe(325_000);
    });

    it('creates Loan/MemberLoanAccount immediately and calls NotificationPort immediately, before any workflow action', async () => {
      const { groupId, customerIds } = await createApprovedGroup(createCustomer, 3);
      const product = await createApprovedProduct();

      const result = await loansService.raiseApplication(
        groupId,
        product._id.toString(),
        product.tenureOptions[0]!,
        customerIds.map((customerId) => ({
          customerId,
          requestedAmountKobo: 100_000,
          disbursementChannel: DisbursementChannel.TRANSFER,
        })),
        INITIATOR_ID,
      );

      // Immediate persistence — not deferred until approval.
      expect(result.loan.status).toBe(LoanStatus.PENDING_APPROVAL);
      const persistedLoan = await loanModel.findById(result.loan._id).exec();
      expect(persistedLoan).not.toBeNull();
      const persistedAccounts = await memberLoanAccountModel
        .find({ loanId: result.loan._id })
        .exec();
      expect(persistedAccounts).toHaveLength(3);
      expect(persistedAccounts.every((a) => a.status === MemberLoanAccountStatus.PENDING)).toBe(
        true,
      );

      // NotificationPort called immediately — verified via the PendingNotificationLog stub.
      const notifications = await pendingNotificationLogModel
        .find({
          'payload.loanId': { $exists: false },
          recipientCustomerId: { $in: customerIds.map((id) => new Types.ObjectId(id)) },
        })
        .exec();
      expect(notifications.length).toBeGreaterThanOrEqual(3);
      expect(notifications.every((n) => n.dispatched === false)).toBe(true);
    });

    it('the workflow request carries the pre-existing loan._id as entityId and uses the dynamically-registered LOAN/APPROVE_<productId> chain', async () => {
      const { groupId, customerIds } = await createApprovedGroup(createCustomer, 3);
      const product = await createApprovedProduct();

      const result = await loansService.raiseApplication(
        groupId,
        product._id.toString(),
        product.tenureOptions[0]!,
        customerIds.map((customerId) => ({
          customerId,
          requestedAmountKobo: 100_000,
          disbursementChannel: DisbursementChannel.TRANSFER,
        })),
        INITIATOR_ID,
      );

      expect(result.workflowRequest.entityId).toBe(result.loan._id.toString());
      expect(result.workflowRequest.action).toBe(loanApprovalActionFor(product._id.toString()));
      expect(result.workflowRequest.steps.map((s) => s.requiredCapability)).toEqual([
        approveCapability(WorkflowEntityType.LOAN),
      ]);
    });

    it('surfaces (but never blocks on) outstanding PRE_LOAN fees per member', async () => {
      const feeId = await createApprovedFee({ timing: FeeTiming.PRE_LOAN, value: 2_000 });
      const { groupId, customerIds } = await createApprovedGroup(createCustomer, 3);
      const product = await createApprovedProduct({ feeIds: [feeId] });

      const result = await loansService.raiseApplication(
        groupId,
        product._id.toString(),
        product.tenureOptions[0]!,
        customerIds.map((customerId) => ({
          customerId,
          requestedAmountKobo: 100_000,
          disbursementChannel: DisbursementChannel.TRANSFER,
        })),
        INITIATOR_ID,
      );

      // Nothing paid yet — every member's fee is outstanding, but the loan
      // still raises successfully (surfaced, not blocked).
      expect(result.loan.status).toBe(LoanStatus.PENDING_APPROVAL);
      expect(result.outstandingPreLoanFees).toHaveLength(3);
      expect(result.outstandingPreLoanFees[0]?.fees[0]).toMatchObject({
        feeDefinitionId: feeId,
        amountKobo: 2_000,
      });

      // Once recorded as PAID, that member drops out of the outstanding list.
      await feePaymentModel.create({
        customerId: new Types.ObjectId(customerIds[0]!),
        branchId: new Types.ObjectId(branchId),
        productId: product._id,
        feeDefinitionId: new Types.ObjectId(feeId),
        amountKobo: 2_000,
        status: 'PAID',
        recordedBy: new Types.ObjectId(INITIATOR_ID),
        recordedAt: new Date(),
      });

      const secondResult = await loansService.raiseApplication(
        groupId,
        product._id.toString(),
        product.tenureOptions[0]!,
        customerIds.map((customerId) => ({
          customerId,
          requestedAmountKobo: 100_000,
          disbursementChannel: DisbursementChannel.TRANSFER,
        })),
        INITIATOR_ID,
      );
      expect(secondResult.outstandingPreLoanFees).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Workflow outcome
  // ---------------------------------------------------------------------------

  describe('workflow outcome', () => {
    it('rejection closes all MemberLoanAccounts without ever activating them', async () => {
      const { groupId, customerIds } = await createApprovedGroup(createCustomer, 3);
      const product = await createApprovedProduct();

      const result = await loansService.raiseApplication(
        groupId,
        product._id.toString(),
        product.tenureOptions[0]!,
        customerIds.map((customerId) => ({
          customerId,
          requestedAmountKobo: 100_000,
          disbursementChannel: DisbursementChannel.TRANSFER,
        })),
        INITIATOR_ID,
      );

      await workflowEngineService.act({
        workflowRequestId: result.workflowRequest._id.toString(),
        actor: APPROVE_LOAN_ACTOR,
        action: WorkflowStepAction.REJECTED,
        comment: 'not this time',
      });

      const loan = await loanModel.findById(result.loan._id).exec();
      expect(loan?.status).toBe(LoanStatus.REJECTED);

      const accounts = await memberLoanAccountModel.find({ loanId: result.loan._id }).exec();
      expect(accounts.every((a) => a.status === MemberLoanAccountStatus.CLOSED)).toBe(true);
      expect(accounts.some((a) => a.status === MemberLoanAccountStatus.ACTIVE)).toBe(false);
    });

    it('approval sets Loan.status = APPROVED', async () => {
      const { groupId, customerIds } = await createApprovedGroup(createCustomer, 3);
      const product = await createApprovedProduct();

      const result = await loansService.raiseApplication(
        groupId,
        product._id.toString(),
        product.tenureOptions[0]!,
        customerIds.map((customerId) => ({
          customerId,
          requestedAmountKobo: 100_000,
          disbursementChannel: DisbursementChannel.TRANSFER,
        })),
        INITIATOR_ID,
      );

      await approveLoan(result.loan._id.toString());

      const loan = await loanModel.findById(result.loan._id).exec();
      expect(loan?.status).toBe(LoanStatus.APPROVED);
      expect(loan?.approvedAt).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // initiateMemberVerification
  // ---------------------------------------------------------------------------

  describe('initiateMemberVerification', () => {
    it('a passing BVN + facial match sets PASSED', async () => {
      const { loanId, customerIds } = await raiseAndApproveLoan(3);

      const verification = await loanVerificationService.initiateMemberVerification(
        loanId,
        customerIds[0]!,
        Buffer.from('live-image-ok'),
        INITIATOR_ID,
      );

      expect(verification.status).toBe(DisbursementVerificationStatus.PASSED);
      expect(verification.bvnRecheck?.status).toBe('PASSED');
      expect(verification.facialMatch?.status).toBe('PASSED');

      const persisted = await disbursementVerificationModel.findById(verification._id).exec();
      expect(persisted?.status).toBe(DisbursementVerificationStatus.PASSED);

      const loan = await loanModel.findById(loanId).exec();
      expect(loan?.status).toBe(LoanStatus.VERIFICATION_IN_PROGRESS);
    });

    it('a failing facial match sets ESCALATED (not FAILED) and triggers sendVerificationEscalation', async () => {
      const { loanId, customerIds } = await raiseAndApproveLoan(3);

      const verification = await loanVerificationService.initiateMemberVerification(
        loanId,
        customerIds[0]!,
        Buffer.from(MOCK_FACE_COMPARISON_FAIL_MARKER),
        INITIATOR_ID,
      );

      expect(verification.status).toBe(DisbursementVerificationStatus.ESCALATED);
      expect(verification.status).not.toBe(DisbursementVerificationStatus.FAILED);
      expect(verification.facialMatch?.status).toBe('FAILED');
      expect(verification.escalationReason).toContain('Facial match');

      const escalationNotification = await pendingNotificationLogModel
        .findOne({
          type: 'VERIFICATION_ESCALATED',
          recipientCustomerId: new Types.ObjectId(customerIds[0]!),
        })
        .exec();
      expect(escalationNotification).not.toBeNull();
    });

    it('directVerify is called live every time, never cached — even for the same customer twice', async () => {
      const { loanId, customerIds } = await raiseAndApproveLoan(3);
      const spy = jest.spyOn(mockBvnAdapter, 'directVerify');
      const callsBefore = spy.mock.calls.length;

      await loanVerificationService.initiateMemberVerification(
        loanId,
        customerIds[0]!,
        Buffer.from(MOCK_FACE_COMPARISON_FAIL_MARKER), // fails facial match, but BVN recheck still runs first
        INITIATOR_ID,
      );
      await loanVerificationService.initiateMemberVerification(
        loanId,
        customerIds[0]!,
        Buffer.from(MOCK_FACE_COMPARISON_FAIL_MARKER),
        INITIATOR_ID,
      );

      expect(spy.mock.calls.length - callsBefore).toBe(2);
    });

    it('throws when the BVN provider is unavailable — recorded as a FAILED recheck, routed to ESCALATED', async () => {
      const { loanId, customerIds } = await raiseAndApproveLoan(3);
      jest
        .spyOn(mockBvnAdapter, 'directVerify')
        .mockRejectedValueOnce(new BvnProviderUnavailableException('direct verification'));

      const verification = await loanVerificationService.initiateMemberVerification(
        loanId,
        customerIds[0]!,
        Buffer.from('live-image-ok'),
        INITIATOR_ID,
      );

      expect(verification.bvnRecheck?.status).toBe('FAILED');
      expect(verification.status).toBe(DisbursementVerificationStatus.ESCALATED);
    });
  });

  // ---------------------------------------------------------------------------
  // resolveEscalation
  // ---------------------------------------------------------------------------

  describe('resolveEscalation', () => {
    it('OVERRIDE_PASS writes a prominent audit entry and allows disbursement to proceed', async () => {
      const { loanId, customerIds } = await raiseAndApproveLoan(3);

      const escalated = await loanVerificationService.initiateMemberVerification(
        loanId,
        customerIds[0]!,
        Buffer.from(MOCK_FACE_COMPARISON_FAIL_MARKER),
        INITIATOR_ID,
      );
      for (const customerId of customerIds.slice(1)) {
        await passVerification(loanId, customerId);
      }

      const resolved = await loanVerificationService.resolveEscalation(
        escalated._id.toString(),
        ADMIN_ID,
        'OVERRIDE_PASS',
        'Confirmed identity via alternate means — compliance-approved override',
      );

      expect(resolved.status).toBe(DisbursementVerificationStatus.PASSED);
      expect(resolved.resolvedBy?.toString()).toBe(ADMIN_ID);

      const auditEntry = await auditLogModel
        .findOne({
          action: 'DISBURSEMENT_VERIFICATION_OVERRIDE_PASS',
          entityId: escalated._id.toString(),
        })
        .exec();
      expect(auditEntry).not.toBeNull();

      // All 3 members now PASSED — disbursement should have proceeded.
      const loan = await loanModel.findById(loanId).exec();
      expect(loan?.status).toBe(LoanStatus.DISBURSED);
    });

    it('REJECT_LOAN rejects the whole loan and closes every member account', async () => {
      const { loanId, customerIds } = await raiseAndApproveLoan(3);

      const escalated = await loanVerificationService.initiateMemberVerification(
        loanId,
        customerIds[0]!,
        Buffer.from(MOCK_FACE_COMPARISON_FAIL_MARKER),
        INITIATOR_ID,
      );

      await loanVerificationService.resolveEscalation(
        escalated._id.toString(),
        ADMIN_ID,
        'REJECT_LOAN',
        'Suspected fraud — declining to override',
      );

      const loan = await loanModel.findById(loanId).exec();
      expect(loan?.status).toBe(LoanStatus.REJECTED);

      const accounts = await memberLoanAccountModel
        .find({ loanId: new Types.ObjectId(loanId) })
        .exec();
      expect(accounts.every((a) => a.status === MemberLoanAccountStatus.CLOSED)).toBe(true);
    });

    it('rejects resolving a verification that is not currently ESCALATED', async () => {
      const { loanId, customerIds } = await raiseAndApproveLoan(3);
      const passed = await loanVerificationService.initiateMemberVerification(
        loanId,
        customerIds[0]!,
        Buffer.from('live-image-ok'),
        INITIATOR_ID,
      );

      await expect(
        loanVerificationService.resolveEscalation(
          passed._id.toString(),
          ADMIN_ID,
          'OVERRIDE_PASS',
          'n/a',
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('requires a non-empty note', async () => {
      const { loanId, customerIds } = await raiseAndApproveLoan(3);
      const escalated = await loanVerificationService.initiateMemberVerification(
        loanId,
        customerIds[0]!,
        Buffer.from(MOCK_FACE_COMPARISON_FAIL_MARKER),
        INITIATOR_ID,
      );

      await expect(
        loanVerificationService.resolveEscalation(
          escalated._id.toString(),
          ADMIN_ID,
          'OVERRIDE_PASS',
          '',
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ---------------------------------------------------------------------------
  // checkAndDisburse
  // ---------------------------------------------------------------------------

  describe('checkAndDisburse', () => {
    it('does not trigger disbursement until every member has passed — 2 of 3 is not enough', async () => {
      const { loanId, customerIds } = await raiseAndApproveLoan(3);

      await passVerification(loanId, customerIds[0]!);
      await passVerification(loanId, customerIds[1]!);
      // customerIds[2] never verified.

      const loan = await loanModel.findById(loanId).exec();
      expect(loan?.status).toBe(LoanStatus.VERIFICATION_IN_PROGRESS);

      const accounts = await memberLoanAccountModel
        .find({ loanId: new Types.ObjectId(loanId) })
        .exec();
      expect(accounts.every((a) => a.status === MemberLoanAccountStatus.PENDING)).toBe(true);
      expect(accounts.every((a) => a.schedule.length === 0)).toBe(true);

      const balance = await branchFundBalanceService.getBalance(branchId);
      expect(balance).toBe(1_000_000_000); // untouched
    });

    it('disburses once the last member passes', async () => {
      const { loanId, customerIds } = await raiseAndApproveLoan(3);

      await passVerification(loanId, customerIds[0]!);
      await passVerification(loanId, customerIds[1]!);
      await passVerification(loanId, customerIds[2]!);

      const loan = await loanModel.findById(loanId).exec();
      expect(loan?.status).toBe(LoanStatus.DISBURSED);
      expect(loan?.disbursedAt).not.toBeNull();

      const accounts = await memberLoanAccountModel
        .find({ loanId: new Types.ObjectId(loanId) })
        .exec();
      expect(accounts.every((a) => a.status === MemberLoanAccountStatus.ACTIVE)).toBe(true);
      expect(accounts.every((a) => a.schedule.length > 0)).toBe(true);
      expect(accounts.every((a) => typeof a.outstandingBalanceKobo === 'number')).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Disbursement transaction correctness
  // ---------------------------------------------------------------------------

  describe('disbursement transaction', () => {
    it('all-or-nothing: InsufficientBranchFundsException leaves zero members active/debited', async () => {
      const { loanId, customerIds } = await raiseAndApproveLoan(3);
      // Drain the branch's funds below the cumulative amount required.
      await branchFundBalanceModel
        .updateOne({ branchId: new Types.ObjectId(branchId) }, { $set: { availableAmount: 1 } })
        .exec();

      await passVerification(loanId, customerIds[0]!);
      await passVerification(loanId, customerIds[1]!);
      // Final member's verification triggers the (failing) auto-disbursement
      // attempt internally, but must not throw out of initiateMemberVerification.
      await passVerification(loanId, customerIds[2]!);

      const loan = await loanModel.findById(loanId).exec();
      expect(loan?.status).toBe(LoanStatus.VERIFICATION_IN_PROGRESS);

      const accounts = await memberLoanAccountModel
        .find({ loanId: new Types.ObjectId(loanId) })
        .exec();
      expect(accounts.every((a) => a.status === MemberLoanAccountStatus.PENDING)).toBe(true);
      expect(accounts.every((a) => a.schedule.length === 0)).toBe(true);
      expect(accounts.every((a) => a.outstandingBalanceKobo === null)).toBe(true);

      const balance = await branchFundBalanceService.getBalance(branchId);
      expect(balance).toBe(1); // untouched — the debit never applied

      // A manual retry after funding is resolved succeeds.
      await branchFundBalanceModel
        .updateOne(
          { branchId: new Types.ObjectId(branchId) },
          { $set: { availableAmount: 1_000_000_000 } },
        )
        .exec();
      const retried = await loanVerificationService.checkAndDisburse(loanId, INITIATOR_ID);
      expect(retried.status).toBe(LoanStatus.DISBURSED);
    });

    it('repayment schedules generated at disbursement match calculateFlatInterestSchedule exactly', async () => {
      const { loanId, customerIds, product } = await raiseAndApproveLoan(3, {
        interestType: InterestType.FLAT,
        interestRate: 1_800,
        tenureOptions: [6],
      });

      for (const customerId of customerIds) {
        await passVerification(loanId, customerId);
      }

      const accounts = await memberLoanAccountModel
        .find({ loanId: new Types.ObjectId(loanId) })
        .exec();
      for (const account of accounts) {
        const expected = calculateFlatInterestSchedule(
          account.principalAmountKobo,
          product.interestRate,
          product.tenureOptions[0]!,
        );
        expect(account.schedule).toHaveLength(expected.schedule.length);
        expected.schedule.forEach((expectedEntry, index) => {
          const actualEntry = account.schedule[index]!;
          expect(actualEntry.principalPortion).toBe(expectedEntry.principalPortion);
          expect(actualEntry.interestPortion).toBe(expectedEntry.interestPortion);
          expect(actualEntry.totalDue).toBe(expectedEntry.totalDue);
        });
        expect(account.outstandingBalanceKobo).toBe(
          account.principalAmountKobo + expected.totalInterestKobo,
        );
      }
    });
  });
});
