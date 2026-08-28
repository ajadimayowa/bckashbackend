import { randomBytes } from 'node:crypto';

import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model, Types } from 'mongoose';

import { __resetPiiEncryptionKeyCache } from '../../common/crypto/pii-encryption';
import { CustomerStatus, KycStatus } from '../../common/enums/customer.enums';
import { StaffRole } from '../../common/enums/identity.enums';
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
  FeePaymentStatus,
  LoanStatus,
  MemberLoanAccountStatus,
} from '../../common/enums/loan.enums';
import { WorkflowEntityType, WorkflowStatus, WorkflowStepAction } from '../../common/enums/workflow.enums';
import { InMemoryMongo } from '../../test-utils/in-memory-mongo';
import { testAwsConfigModule } from '../../test-utils/test-aws-config.module';
import { AuditModule } from '../../platform/audit/audit.module';
import { AuditLog, AuditLogDocument } from '../../platform/audit/schemas/audit-log.schema';
import { EncryptionService } from '../../platform/encryption/encryption.service';
import { BvnCallLogService } from '../../platform/integrations/bvn/bvn-call-log.service';
import { BvnProviderUnavailableException } from '../../platform/integrations/bvn/exceptions/bvn-provider-unavailable.exception';
import { BVN_VERIFICATION_ADAPTER } from '../../platform/integrations/bvn/interfaces/bvn-verification-adapter.interface';
import { MockBvnVerificationAdapter } from '../../platform/integrations/bvn/mock-bvn-verification.adapter';
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
import { Staff, StaffSchema } from '../identity/schemas/staff.schema';
import { CustomerService } from '../customers/customer.service';
import { Customer, CustomerDocument, CustomerSchema } from '../customers/schemas/customer.schema';
import { KycRecord, KycRecordSchema } from '../customers/schemas/kyc-record.schema';
import { BvnVerificationPreview, BvnVerificationPreviewSchema } from '../customers/schemas/bvn-verification-preview.schema';
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
import { LoanConsentService } from './loan-consent.service';
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
  LoanConsentChallenge,
  LoanConsentChallengeSchema,
} from './schemas/loan-consent-challenge.schema';
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
  let loanConsentService: LoanConsentService;
  let feePaymentsService: FeePaymentsService;
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
          { name: Staff.name, schema: StaffSchema },
          { name: BranchFundBalance.name, schema: BranchFundBalanceSchema },
          { name: Customer.name, schema: CustomerSchema },
          { name: KycRecord.name, schema: KycRecordSchema },
          { name: BvnVerificationPreview.name, schema: BvnVerificationPreviewSchema },
          { name: BvnCallLog.name, schema: BvnCallLogSchema },
          { name: FaceComparisonCallLog.name, schema: FaceComparisonCallLogSchema },
          { name: LoanProduct.name, schema: LoanProductSchema },
          { name: FeeDefinition.name, schema: FeeDefinitionSchema },
          { name: WorkflowChainConfig.name, schema: WorkflowChainConfigSchema },
          { name: WorkflowRequest.name, schema: WorkflowRequestSchema },
          { name: PendingNotificationLog.name, schema: PendingNotificationLogSchema },
          { name: LoanConsentChallenge.name, schema: LoanConsentChallengeSchema },
        ]),
        AuditModule,
        EventEmitterModule.forRoot(),
        await testAwsConfigModule(),
      ],
      providers: [
        LoansService,
        LoanVerificationService,
        FeePaymentsService,
        LoanConsentService,
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
    loanConsentService = moduleRef.get(LoanConsentService);
    feePaymentsService = moduleRef.get(FeePaymentsService);
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

  /**
   * Full BVN-verification + biometric-capture flow — needed for
   * verification tests. Also fast-forwards `status` straight to ACTIVE
   * (bypassing the customer's own review/approve workflow, which isn't
   * what these loan-focused tests are exercising) — GroupsService's
   * pre-approval validator now requires every proposed member to be an
   * ACTIVE customer before a group itself can be approved, and every
   * caller here immediately builds a group out of these customers.
   */
  async function createVerifiedCustomerWithBiometrics(): Promise<string> {
    customerCounter += 1;
    const bvn = `${10_000_000_000 + customerCounter}`.slice(0, 11);
    const { customer } = await customerService.verifyBvnAndCreateCustomer(bvn, branchId, INITIATOR_ID);
    await customerService.captureBiometric(
      customer._id.toString(),
      Buffer.from('biometric-image'),
      'image/jpeg',
      INITIATOR_ID,
    );
    await customerModel.updateOne({ _id: customer._id }, { $set: { status: CustomerStatus.ACTIVE } }).exec();
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

  /**
   * Issues a real LoanConsentChallenge for `customerId` and recovers the
   * plaintext code from the PendingNotificationLog stub's payload (the only
   * place it exists outside the one-way hash — see LoanConsentService's own
   * comment) — every `raiseApplication` call in this file needs one.
   */
  async function issueConsent(customerId: string): Promise<{ challengeId: string; code: string }> {
    const { challengeId } = await loanConsentService.issueChallenge(customerId, INITIATOR_ID);
    const log = await pendingNotificationLogModel
      .findOne({ recipientCustomerId: new Types.ObjectId(customerId) })
      .sort({ createdAt: -1 })
      .exec();
    const code = (log?.payload as { code?: string } | undefined)?.code;
    if (!code) {
      throw new Error(`issueConsent: no PendingNotificationLog code found for customer ${customerId}`);
    }
    return { challengeId, code };
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
      tenureOptions: [14, 30],
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
    const { challengeId, code } = await issueConsent(customerIds[0]!);
    const result = await loansService.raiseApplication(
      groupId,
      product._id.toString(),
      product.tenureOptions[0]!,
      customerIds.map((customerId) => ({
        customerId,
        requestedAmountKobo: 200_000,
        disbursementChannel: DisbursementChannel.TRANSFER,
        bankAccountDetails: { accountName: 'Test Account', accountNumber: '0123456789', bankName: 'Test Bank' },
      })),
      INITIATOR_ID,
      challengeId,
      code,
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
      const { challengeId, code } = await issueConsent(customerIds[0]!);

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
            bankAccountDetails: { accountName: 'Test Account', accountNumber: '0123456789', bankName: 'Test Bank' },
          })),
          INITIATOR_ID,
          challengeId,
          code,
        );
      } catch (error) {
        caught = error as ConflictException;
      }

      expect(caught).toBeInstanceOf(ConflictException);
      const response = caught?.getResponse() as { ineligibleMembers?: { reason: string }[] };
      expect(response.ineligibleMembers?.some((m) => m.reason === 'KYC not complete')).toBe(true);
    });

    it('rejects raising without a valid consent code — wrong code', async () => {
      const { groupId, customerIds } = await createApprovedGroup(createCustomer, 3);
      const product = await createApprovedProduct();
      const { challengeId } = await issueConsent(customerIds[0]!);

      await expect(
        loansService.raiseApplication(
          groupId,
          product._id.toString(),
          product.tenureOptions[0]!,
          customerIds.map((customerId) => ({
            customerId,
            requestedAmountKobo: 100_000,
            disbursementChannel: DisbursementChannel.TRANSFER,
            bankAccountDetails: { accountName: 'Test Account', accountNumber: '0123456789', bankName: 'Test Bank' },
          })),
          INITIATOR_ID,
          challengeId,
          '000000',
        ),
      ).rejects.toThrow(/consent code/i);
    });

    it('rejects raising with a consent code issued for a customer not in this application', async () => {
      const { groupId, customerIds } = await createApprovedGroup(createCustomer, 3);
      const outsiderCustomerId = await createCustomer();
      const product = await createApprovedProduct();
      const { challengeId, code } = await issueConsent(outsiderCustomerId);

      await expect(
        loansService.raiseApplication(
          groupId,
          product._id.toString(),
          product.tenureOptions[0]!,
          customerIds.map((customerId) => ({
            customerId,
            requestedAmountKobo: 100_000,
            disbursementChannel: DisbursementChannel.TRANSFER,
            bankAccountDetails: { accountName: 'Test Account', accountNumber: '0123456789', bankName: 'Test Bank' },
          })),
          INITIATOR_ID,
          challengeId,
          code,
        ),
      ).rejects.toThrow(/not issued for any customer/);
    });

    it('rejects reusing an already-consumed consent code', async () => {
      const { groupId, customerIds } = await createApprovedGroup(createCustomer, 3);
      const product = await createApprovedProduct();
      const { challengeId, code } = await issueConsent(customerIds[0]!);
      const memberLoanRequests = customerIds.map((customerId) => ({
        customerId,
        requestedAmountKobo: 100_000,
        disbursementChannel: DisbursementChannel.TRANSFER,
        bankAccountDetails: { accountName: 'Test Account', accountNumber: '0123456789', bankName: 'Test Bank' },
      }));

      await loansService.raiseApplication(
        groupId,
        product._id.toString(),
        product.tenureOptions[0]!,
        memberLoanRequests,
        INITIATOR_ID,
        challengeId,
        code,
      );

      await expect(
        loansService.raiseApplication(
          groupId,
          product._id.toString(),
          product.tenureOptions[0]!,
          memberLoanRequests,
          INITIATOR_ID,
          challengeId,
          code,
        ),
      ).rejects.toThrow(/consent code/i);
    });

    it('rejects a TRANSFER member request with no bankAccountDetails', async () => {
      const { groupId, customerIds } = await createApprovedGroup(createCustomer, 3);
      const product = await createApprovedProduct();
      const { challengeId, code } = await issueConsent(customerIds[0]!);

      await expect(
        loansService.raiseApplication(
          groupId,
          product._id.toString(),
          product.tenureOptions[0]!,
          customerIds.map((customerId) => ({
            customerId,
            requestedAmountKobo: 100_000,
            disbursementChannel: DisbursementChannel.TRANSFER,
          })),
          INITIATOR_ID,
          challengeId,
          code,
        ),
      ).rejects.toThrow(/bankAccountDetails is required/);
    });

    it('allows a CHEQUE_PICKUP member request with no bankAccountDetails', async () => {
      const { groupId, customerIds } = await createApprovedGroup(createCustomer, 3);
      const product = await createApprovedProduct();
      const { challengeId, code } = await issueConsent(customerIds[0]!);

      const result = await loansService.raiseApplication(
        groupId,
        product._id.toString(),
        product.tenureOptions[0]!,
        customerIds.map((customerId) => ({
          customerId,
          requestedAmountKobo: 100_000,
          disbursementChannel: DisbursementChannel.CHEQUE_PICKUP,
        })),
        INITIATOR_ID,
        challengeId,
        code,
      );

      expect(result.loan.status).toBe(LoanStatus.PENDING_APPROVAL);
      expect(result.memberLoanAccounts.every((a) => a.bankAccountDetails === null)).toBe(true);
    });

    it('rejects an out-of-range tenureDays', async () => {
      const { groupId, customerIds } = await createApprovedGroup(createCustomer, 3);
      const product = await createApprovedProduct({ tenureOptions: [14, 30] });
      const { challengeId, code } = await issueConsent(customerIds[0]!);

      await expect(
        loansService.raiseApplication(
          groupId,
          product._id.toString(),
          99,
          customerIds.map((customerId) => ({
            customerId,
            requestedAmountKobo: 100_000,
            disbursementChannel: DisbursementChannel.TRANSFER,
            bankAccountDetails: { accountName: 'Test Account', accountNumber: '0123456789', bankName: 'Test Bank' },
          })),
          INITIATOR_ID,
          challengeId,
          code,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('correctly computes cumulativeAmountKobo', async () => {
      const { groupId, customerIds } = await createApprovedGroup(createCustomer, 3);
      const product = await createApprovedProduct();
      const { challengeId, code } = await issueConsent(customerIds[0]!);
      const bankAccountDetails = { accountName: 'Test Account', accountNumber: '0123456789', bankName: 'Test Bank' };

      const result = await loansService.raiseApplication(
        groupId,
        product._id.toString(),
        product.tenureOptions[0]!,
        [
          {
            customerId: customerIds[0]!,
            requestedAmountKobo: 100_000,
            disbursementChannel: DisbursementChannel.TRANSFER,
            bankAccountDetails,
          },
          {
            customerId: customerIds[1]!,
            requestedAmountKobo: 150_000,
            disbursementChannel: DisbursementChannel.TRANSFER,
            bankAccountDetails,
          },
          {
            customerId: customerIds[2]!,
            requestedAmountKobo: 75_000,
            disbursementChannel: DisbursementChannel.TRANSFER,
            bankAccountDetails,
          },
        ],
        INITIATOR_ID,
        challengeId,
        code,
      );

      expect(result.loan.cumulativeAmountKobo).toBe(325_000);
    });

    it('creates Loan/MemberLoanAccount immediately and calls NotificationPort immediately, before any workflow action', async () => {
      const { groupId, customerIds } = await createApprovedGroup(createCustomer, 3);
      const product = await createApprovedProduct();
      const { challengeId, code } = await issueConsent(customerIds[0]!);

      const result = await loansService.raiseApplication(
        groupId,
        product._id.toString(),
        product.tenureOptions[0]!,
        customerIds.map((customerId) => ({
          customerId,
          requestedAmountKobo: 100_000,
          disbursementChannel: DisbursementChannel.TRANSFER,
          bankAccountDetails: { accountName: 'Test Account', accountNumber: '0123456789', bankName: 'Test Bank' },
        })),
        INITIATOR_ID,
        challengeId,
        code,
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
      const { challengeId, code } = await issueConsent(customerIds[0]!);

      const result = await loansService.raiseApplication(
        groupId,
        product._id.toString(),
        product.tenureOptions[0]!,
        customerIds.map((customerId) => ({
          customerId,
          requestedAmountKobo: 100_000,
          disbursementChannel: DisbursementChannel.TRANSFER,
          bankAccountDetails: { accountName: 'Test Account', accountNumber: '0123456789', bankName: 'Test Bank' },
        })),
        INITIATOR_ID,
        challengeId,
        code,
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
      const bankAccountDetails = { accountName: 'Test Account', accountNumber: '0123456789', bankName: 'Test Bank' };
      const firstConsent = await issueConsent(customerIds[0]!);

      const result = await loansService.raiseApplication(
        groupId,
        product._id.toString(),
        product.tenureOptions[0]!,
        customerIds.map((customerId) => ({
          customerId,
          requestedAmountKobo: 100_000,
          disbursementChannel: DisbursementChannel.TRANSFER,
          bankAccountDetails,
        })),
        INITIATOR_ID,
        firstConsent.challengeId,
        firstConsent.code,
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

      // The first loan is still PENDING_APPROVAL — raising a second one for
      // the same customers is now blocked (see the new "one loan at a time
      // per customer" describe block below) unless the first is resolved
      // first. Reject it purely to unblock this fee-status test, which
      // isn't itself testing that rule.
      await loansService.rejectLoan(result.loan._id.toString(), 'superseded by test');

      const secondConsent = await issueConsent(customerIds[0]!);
      const secondResult = await loansService.raiseApplication(
        groupId,
        product._id.toString(),
        product.tenureOptions[0]!,
        customerIds.map((customerId) => ({
          customerId,
          requestedAmountKobo: 100_000,
          disbursementChannel: DisbursementChannel.TRANSFER,
          bankAccountDetails,
        })),
        INITIATOR_ID,
        secondConsent.challengeId,
        secondConsent.code,
      );
      expect(secondResult.outstandingPreLoanFees).toHaveLength(2);
    });
  });

  describe('one loan at a time per customer', () => {
    it('rejects raising a second loan while a member already has a pending loan', async () => {
      const { groupId, customerIds } = await createApprovedGroup(createCustomer, 3);
      const product = await createApprovedProduct();
      const firstConsent = await issueConsent(customerIds[0]!);
      await loansService.raiseApplication(
        groupId,
        product._id.toString(),
        product.tenureOptions[0]!,
        customerIds.map((customerId) => ({
          customerId,
          requestedAmountKobo: 100_000,
          disbursementChannel: DisbursementChannel.CHEQUE_PICKUP,
        })),
        INITIATOR_ID,
        firstConsent.challengeId,
        firstConsent.code,
      );

      const secondConsent = await issueConsent(customerIds[0]!);
      await expect(
        loansService.raiseApplication(
          groupId,
          product._id.toString(),
          product.tenureOptions[0]!,
          customerIds.map((customerId) => ({
            customerId,
            requestedAmountKobo: 100_000,
            disbursementChannel: DisbursementChannel.CHEQUE_PICKUP,
          })),
          INITIATOR_ID,
          secondConsent.challengeId,
          secondConsent.code,
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('allows raising a new loan once the previous one is rejected', async () => {
      const { groupId, customerIds } = await createApprovedGroup(createCustomer, 3);
      const product = await createApprovedProduct();
      const firstConsent = await issueConsent(customerIds[0]!);
      const first = await loansService.raiseApplication(
        groupId,
        product._id.toString(),
        product.tenureOptions[0]!,
        customerIds.map((customerId) => ({
          customerId,
          requestedAmountKobo: 100_000,
          disbursementChannel: DisbursementChannel.CHEQUE_PICKUP,
        })),
        INITIATOR_ID,
        firstConsent.challengeId,
        firstConsent.code,
      );
      await loansService.rejectLoan(first.loan._id.toString(), 'test');

      const secondConsent = await issueConsent(customerIds[0]!);
      const second = await loansService.raiseApplication(
        groupId,
        product._id.toString(),
        product.tenureOptions[0]!,
        customerIds.map((customerId) => ({
          customerId,
          requestedAmountKobo: 100_000,
          disbursementChannel: DisbursementChannel.CHEQUE_PICKUP,
        })),
        INITIATOR_ID,
        secondConsent.challengeId,
        secondConsent.code,
      );
      expect(second.loan.status).toBe(LoanStatus.PENDING_APPROVAL);
    });
  });

  describe('updatePendingApplication', () => {
    it('updates tenureDays, purpose, and a member amount while PENDING_APPROVAL, re-deriving cumulativeAmountKobo', async () => {
      const { groupId, customerIds } = await createApprovedGroup(createCustomer, 3);
      const product = await createApprovedProduct({ tenureOptions: [14, 30] });
      const consent = await issueConsent(customerIds[0]!);
      const raised = await loansService.raiseApplication(
        groupId,
        product._id.toString(),
        14,
        customerIds.map((customerId) => ({
          customerId,
          requestedAmountKobo: 100_000,
          disbursementChannel: DisbursementChannel.CHEQUE_PICKUP,
        })),
        INITIATOR_ID,
        consent.challengeId,
        consent.code,
      );

      const { loan, memberLoanAccounts } = await loansService.updatePendingApplication(
        raised.loan._id.toString(),
        INITIATOR_ID,
        {
          tenureDays: 30,
          purpose: 'Updated purpose',
          memberLoanRequests: [
            {
              customerId: customerIds[0]!,
              requestedAmountKobo: 150_000,
              disbursementChannel: DisbursementChannel.CHEQUE_PICKUP,
            },
          ],
        },
      );

      expect(loan.tenureDays).toBe(30);
      expect(loan.purpose).toBe('Updated purpose');
      const updatedAccount = memberLoanAccounts.find((a) => a.customerId.toString() === customerIds[0]);
      expect(updatedAccount?.principalAmountKobo).toBe(150_000);
      expect(loan.cumulativeAmountKobo).toBe(150_000 + 100_000 + 100_000);
    });

    it('rejects editing once the loan has been approved', async () => {
      const { groupId, customerIds } = await createApprovedGroup(createCustomer, 3);
      const product = await createApprovedProduct();
      const consent = await issueConsent(customerIds[0]!);
      const raised = await loansService.raiseApplication(
        groupId,
        product._id.toString(),
        product.tenureOptions[0]!,
        customerIds.map((customerId) => ({
          customerId,
          requestedAmountKobo: 100_000,
          disbursementChannel: DisbursementChannel.CHEQUE_PICKUP,
        })),
        INITIATOR_ID,
        consent.challengeId,
        consent.code,
      );
      await approveLoan(raised.loan._id.toString());

      await expect(
        loansService.updatePendingApplication(raised.loan._id.toString(), INITIATOR_ID, { purpose: 'nope' }),
      ).rejects.toThrow(ConflictException);
    });

    it('rejects editing by anyone other than the raiser', async () => {
      const { groupId, customerIds } = await createApprovedGroup(createCustomer, 3);
      const product = await createApprovedProduct();
      const consent = await issueConsent(customerIds[0]!);
      const raised = await loansService.raiseApplication(
        groupId,
        product._id.toString(),
        product.tenureOptions[0]!,
        customerIds.map((customerId) => ({
          customerId,
          requestedAmountKobo: 100_000,
          disbursementChannel: DisbursementChannel.CHEQUE_PICKUP,
        })),
        INITIATOR_ID,
        consent.challengeId,
        consent.code,
      );

      await expect(
        loansService.updatePendingApplication(
          raised.loan._id.toString(),
          new Types.ObjectId().toString(),
          { purpose: 'nope' },
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('deleteLoan', () => {
    it('hard-deletes a PENDING_APPROVAL loan and every MemberLoanAccount, cancelling the WorkflowRequest', async () => {
      const { groupId, customerIds } = await createApprovedGroup(createCustomer, 3);
      const product = await createApprovedProduct();
      const consent = await issueConsent(customerIds[0]!);
      const raised = await loansService.raiseApplication(
        groupId,
        product._id.toString(),
        product.tenureOptions[0]!,
        customerIds.map((customerId) => ({
          customerId,
          requestedAmountKobo: 100_000,
          disbursementChannel: DisbursementChannel.CHEQUE_PICKUP,
        })),
        INITIATOR_ID,
        consent.challengeId,
        consent.code,
      );
      const loanId = raised.loan._id.toString();

      await loansService.deleteLoan(loanId, INITIATOR_ID);

      await expect(loansService.findByIdOrThrow(loanId)).rejects.toThrow(NotFoundException);
      const remainingAccounts = await loansService.getMemberLoanAccounts(loanId);
      expect(remainingAccounts).toHaveLength(0);

      const history = await workflowEngineService.getHistory(WorkflowEntityType.LOAN, loanId);
      expect(history[history.length - 1]?.status).toBe(WorkflowStatus.CANCELLED);

      // Deleting it freed the customers up to be raised for again.
      const secondConsent = await issueConsent(customerIds[0]!);
      const second = await loansService.raiseApplication(
        groupId,
        product._id.toString(),
        product.tenureOptions[0]!,
        customerIds.map((customerId) => ({
          customerId,
          requestedAmountKobo: 100_000,
          disbursementChannel: DisbursementChannel.CHEQUE_PICKUP,
        })),
        INITIATOR_ID,
        secondConsent.challengeId,
        secondConsent.code,
      );
      expect(second.loan.status).toBe(LoanStatus.PENDING_APPROVAL);
    });

    it('rejects deleting once the loan has been approved', async () => {
      const { groupId, customerIds } = await createApprovedGroup(createCustomer, 3);
      const product = await createApprovedProduct();
      const consent = await issueConsent(customerIds[0]!);
      const raised = await loansService.raiseApplication(
        groupId,
        product._id.toString(),
        product.tenureOptions[0]!,
        customerIds.map((customerId) => ({
          customerId,
          requestedAmountKobo: 100_000,
          disbursementChannel: DisbursementChannel.CHEQUE_PICKUP,
        })),
        INITIATOR_ID,
        consent.challengeId,
        consent.code,
      );
      await approveLoan(raised.loan._id.toString());

      await expect(loansService.deleteLoan(raised.loan._id.toString(), INITIATOR_ID)).rejects.toThrow(
        ConflictException,
      );
    });

    it('rejects deleting by anyone other than the raiser', async () => {
      const { groupId, customerIds } = await createApprovedGroup(createCustomer, 3);
      const product = await createApprovedProduct();
      const consent = await issueConsent(customerIds[0]!);
      const raised = await loansService.raiseApplication(
        groupId,
        product._id.toString(),
        product.tenureOptions[0]!,
        customerIds.map((customerId) => ({
          customerId,
          requestedAmountKobo: 100_000,
          disbursementChannel: DisbursementChannel.CHEQUE_PICKUP,
        })),
        INITIATOR_ID,
        consent.challengeId,
        consent.code,
      );

      await expect(
        loansService.deleteLoan(raised.loan._id.toString(), new Types.ObjectId().toString()),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // ---------------------------------------------------------------------------
  // Workflow outcome
  // ---------------------------------------------------------------------------

  describe('workflow outcome', () => {
    it('rejection closes all MemberLoanAccounts without ever activating them', async () => {
      const { groupId, customerIds } = await createApprovedGroup(createCustomer, 3);
      const product = await createApprovedProduct();
      const { challengeId, code } = await issueConsent(customerIds[0]!);

      const result = await loansService.raiseApplication(
        groupId,
        product._id.toString(),
        product.tenureOptions[0]!,
        customerIds.map((customerId) => ({
          customerId,
          requestedAmountKobo: 100_000,
          disbursementChannel: DisbursementChannel.TRANSFER,
          bankAccountDetails: { accountName: 'Test Account', accountNumber: '0123456789', bankName: 'Test Bank' },
        })),
        INITIATOR_ID,
        challengeId,
        code,
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
      const { challengeId, code } = await issueConsent(customerIds[0]!);

      const result = await loansService.raiseApplication(
        groupId,
        product._id.toString(),
        product.tenureOptions[0]!,
        customerIds.map((customerId) => ({
          customerId,
          requestedAmountKobo: 100_000,
          disbursementChannel: DisbursementChannel.TRANSFER,
          bankAccountDetails: { accountName: 'Test Account', accountNumber: '0123456789', bankName: 'Test Bank' },
        })),
        INITIATOR_ID,
        challengeId,
        code,
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
        tenureOptions: [14],
      });

      for (const customerId of customerIds) {
        await passVerification(loanId, customerId);
      }

      const accounts = await memberLoanAccountModel
        .find({ loanId: new Types.ObjectId(loanId) })
        .exec();
      // One installment per repaymentPeriodDays-day cycle (7 = weekly, the
      // default), not one per calendar day of tenure — see
      // LoanProduct.repaymentPeriodDays's own doc comment.
      const installmentCount = Math.ceil(product.tenureOptions[0]! / product.repaymentPeriodDays);
      for (const account of accounts) {
        const expected = calculateFlatInterestSchedule(
          account.principalAmountKobo,
          product.interestRate,
          installmentCount,
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

  describe('getMemberLoanAccountsForCustomer', () => {
    it('returns every MemberLoanAccount for a customer, enriched with the parent loan/product, newest first', async () => {
      const { customerIds, product, loanId } = await raiseAndApproveLoan(3);
      const customerId = customerIds[0]!;

      const history = await loansService.getMemberLoanAccountsForCustomer(customerId);

      expect(history).toHaveLength(1);
      const [item] = history;
      expect(item!.loanId).toBe(loanId);
      expect(item!.loanStatus).toBe(LoanStatus.APPROVED);
      expect(item!.status).toBe(MemberLoanAccountStatus.PENDING);
      expect(item!.principalAmountKobo).toBe(200_000);
      expect(item!.productId).toBe(product._id.toString());
      expect(item!.productName).toBe(product.name);
      expect(item!.interestRateBasisPoints).toBe(product.interestRate);
      expect(item!.tenureDays).toBe(product.tenureOptions[0]);
      expect(item!.disbursedAt).toBeNull();
    });

    it('returns an empty array for a customer with no loan history', async () => {
      const customerId = await createCustomer();
      await expect(loansService.getMemberLoanAccountsForCustomer(customerId)).resolves.toEqual([]);
    });
  });

  describe('listForActor', () => {
    it('returns an enriched summary row — group name, product name, member count, cumulative amount', async () => {
      const { groupId, customerIds, product, loanId } = await raiseAndApproveLoan(3);

      const rows = await loansService.listForActor(
        {},
        { staffId: INITIATOR_ID, role: StaffRole.SUPERADMIN },
      );

      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row!.id).toBe(loanId);
      expect(row!.groupId).toBe(groupId);
      expect(row!.productId).toBe(product._id.toString());
      expect(row!.productName).toBe(product.name);
      expect(row!.memberCount).toBe(customerIds.length);
      expect(row!.cumulativeAmountKobo).toBe(200_000 * customerIds.length);
      // Not yet disbursed — every MemberLoanAccount.outstandingBalanceKobo is still null.
      expect(row!.outstandingBalanceKobo).toBe(0);
      expect(row!.status).toBe(LoanStatus.APPROVED);
    });

    it('estimates totalInterestKobo/totalRepayableKobo (and resolves member names) before disbursement', async () => {
      // FLAT, 18% (1_800 bps), tenure 14 days / repaymentPeriodDays 7 (default) => 2 installments,
      // but FLAT's totalInterestKobo doesn't depend on installment count — just principal * rate.
      const { customerIds, loanId } = await raiseAndApproveLoan(3);

      const rows = await loansService.listForActor(
        {},
        { staffId: INITIATOR_ID, role: StaffRole.SUPERADMIN },
      );
      const row = rows.find((r) => r.id === loanId);

      expect(row!.memberCustomerNames).toHaveLength(customerIds.length);
      expect(row!.memberCustomerNames.every((name) => name && name !== '—')).toBe(true);
      expect(row!.interestIsEstimate).toBe(true);
      // 200_000 * 1_800 / 10_000 = 36_000 per member, x3 members.
      expect(row!.totalInterestKobo).toBe(36_000 * 3);
      expect(row!.totalRepayableKobo).toBe(row!.cumulativeAmountKobo + row!.totalInterestKobo);
    });

    it('switches to the real, schedule-derived totalInterestKobo once disbursed', async () => {
      const { loanId, customerIds } = await raiseAndApproveLoan(3);
      await passVerification(loanId, customerIds[0]!);
      await passVerification(loanId, customerIds[1]!);
      await passVerification(loanId, customerIds[2]!);

      const rows = await loansService.listForActor(
        {},
        { staffId: INITIATOR_ID, role: StaffRole.SUPERADMIN },
      );
      const row = rows.find((r) => r.id === loanId);

      const accounts = await memberLoanAccountModel
        .find({ loanId: new Types.ObjectId(loanId) })
        .exec();
      const expectedInterest = accounts.reduce(
        (sum, account) => sum + account.schedule.reduce((s, entry) => s + entry.interestPortion, 0),
        0,
      );

      expect(row!.interestIsEstimate).toBe(false);
      expect(row!.totalInterestKobo).toBe(expectedInterest);
      expect(row!.totalRepayableKobo).toBe(row!.cumulativeAmountKobo + expectedInterest);
    });

    it("a MANAGER only sees their own branch's loans", async () => {
      await raiseAndApproveLoan(3);
      const otherBranch = await branchModel.create({ name: 'Other', code: `BR${Date.now()}X`, active: true });

      const ownBranchRows = await loansService.listForActor(
        {},
        { staffId: INITIATOR_ID, role: StaffRole.MANAGER, branchId },
      );
      expect(ownBranchRows).toHaveLength(1);

      const otherBranchRows = await loansService.listForActor(
        {},
        { staffId: INITIATOR_ID, role: StaffRole.MANAGER, branchId: otherBranch._id.toString() },
      );
      expect(otherBranchRows).toEqual([]);
    });

    it('a MARKETER only sees loans they themselves raised', async () => {
      await raiseAndApproveLoan(3);
      const otherMarketerId = new Types.ObjectId().toString();

      const ownRows = await loansService.listForActor(
        {},
        { staffId: INITIATOR_ID, role: StaffRole.MARKETER, branchId },
      );
      expect(ownRows).toHaveLength(1);

      const otherRows = await loansService.listForActor(
        {},
        { staffId: otherMarketerId, role: StaffRole.MARKETER, branchId },
      );
      expect(otherRows).toEqual([]);
    });

    it('an ADMIN/SUPERADMIN/APPROVER may filter to one marketer\'s loans via raisedBy', async () => {
      const { loanId } = await raiseAndApproveLoan(3);
      const otherMarketerId = new Types.ObjectId().toString();

      const matching = await loansService.listForActor(
        { raisedBy: INITIATOR_ID },
        { staffId: new Types.ObjectId().toString(), role: StaffRole.SUPERADMIN },
      );
      expect(matching.map((r) => r.id)).toEqual([loanId]);

      const nonMatching = await loansService.listForActor(
        { raisedBy: otherMarketerId },
        { staffId: new Types.ObjectId().toString(), role: StaffRole.SUPERADMIN },
      );
      expect(nonMatching).toEqual([]);
    });

    it('raisedBy is ignored for a MANAGER (still branch-locked) and a MARKETER (already forced to their own)', async () => {
      await raiseAndApproveLoan(3);
      const otherMarketerId = new Types.ObjectId().toString();

      const managerRows = await loansService.listForActor(
        { raisedBy: otherMarketerId },
        { staffId: new Types.ObjectId().toString(), role: StaffRole.MANAGER, branchId },
      );
      expect(managerRows).toHaveLength(1);

      const marketerRows = await loansService.listForActor(
        { raisedBy: otherMarketerId },
        { staffId: INITIATOR_ID, role: StaffRole.MARKETER, branchId },
      );
      expect(marketerRows).toHaveLength(1);
    });
  });

  describe('FeePaymentsService.listForCustomer', () => {
    it('returns a customer\'s fee payments enriched with fee/product names, newest first', async () => {
      const customerId = await createCustomer();
      const feeId = await createApprovedFee({ name: `Registration Fee ${Date.now()}` });
      const product = await createApprovedProduct({ feeIds: [feeId] });

      await feePaymentsService.recordPayment(
        customerId,
        product._id.toString(),
        feeId,
        5_000,
        FeePaymentStatus.PAID,
        INITIATOR_ID,
      );

      const history = await feePaymentsService.listForCustomer(customerId);

      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        productId: product._id.toString(),
        feeDefinitionId: feeId,
        amountKobo: 5_000,
        status: FeePaymentStatus.PAID,
        recordedBy: INITIATOR_ID,
      });
      expect(history[0]!.productName).toBe(product.name);
      expect(history[0]!.feeName).toBeTruthy();
    });

    it('returns an empty array for a customer with no fee payments', async () => {
      const customerId = await createCustomer();
      await expect(feePaymentsService.listForCustomer(customerId)).resolves.toEqual([]);
    });

    it('persists accountPaidTo/paymentReference for a PAID record, drops them for a WAIVED one', async () => {
      const customerId = await createCustomer();
      const feeId = await createApprovedFee({ name: `Registration Fee ${Date.now()}` });
      const product = await createApprovedProduct({ feeIds: [feeId] });

      await feePaymentsService.recordPayment(
        customerId,
        product._id.toString(),
        feeId,
        5_000,
        FeePaymentStatus.PAID,
        INITIATOR_ID,
        'Main Branch Cash Account',
        'TRX-00219',
      );
      const paid = await feePaymentsService.listForCustomer(customerId);
      expect(paid[0]).toMatchObject({ accountPaidTo: 'Main Branch Cash Account', paymentReference: 'TRX-00219' });

      await feePaymentsService.recordPayment(
        customerId,
        product._id.toString(),
        feeId,
        5_000,
        FeePaymentStatus.WAIVED,
        INITIATOR_ID,
        'Should be dropped',
        'Should be dropped',
      );
      const waived = await feePaymentsService.listForCustomer(customerId);
      expect(waived[0]).toMatchObject({ accountPaidTo: null, paymentReference: null, status: FeePaymentStatus.WAIVED });
    });
  });

  describe('FeePaymentsService.listAvailableFeesForCustomer', () => {
    it('reports a PENDING PRE_LOAN fee from an active product that was never recorded', async () => {
      const customerId = await createCustomer();
      const feeId = await createApprovedFee({ name: `Membership Fee ${Date.now()}`, value: 2_000 });
      const product = await createApprovedProduct({ feeIds: [feeId] });

      const available = await feePaymentsService.listAvailableFeesForCustomer(customerId);

      expect(available).toHaveLength(1);
      expect(available[0]).toMatchObject({
        productId: product._id.toString(),
        feeDefinitionId: feeId,
        amountKobo: 2_000,
        status: FeePaymentStatus.PENDING,
        feePaymentId: null,
        accountPaidTo: null,
        paymentReference: null,
      });
    });

    it('flips to PAID once recorded, carrying the account/reference through', async () => {
      const customerId = await createCustomer();
      const feeId = await createApprovedFee({ name: `Registration Fee ${Date.now()}`, value: 3_000 });
      const product = await createApprovedProduct({ feeIds: [feeId] });

      await feePaymentsService.recordPayment(
        customerId,
        product._id.toString(),
        feeId,
        3_000,
        FeePaymentStatus.PAID,
        INITIATOR_ID,
        'Main Branch Cash Account',
        'TRX-00220',
      );

      const available = await feePaymentsService.listAvailableFeesForCustomer(customerId);

      expect(available).toHaveLength(1);
      expect(available[0]).toMatchObject({
        status: FeePaymentStatus.PAID,
        amountKobo: 3_000,
        accountPaidTo: 'Main Branch Cash Account',
        paymentReference: 'TRX-00220',
      });
      expect(available[0]!.feePaymentId).toBeTruthy();
    });

    it('excludes a DURING_LIFECYCLE fee — only PRE_LOAN fees are ever "available" outside a live loan', async () => {
      const customerId = await createCustomer();
      const feeId = await createApprovedFee({ name: `Late Fee ${Date.now()}`, timing: FeeTiming.DURING_LIFECYCLE });
      await createApprovedProduct({ feeIds: [feeId] });

      await expect(feePaymentsService.listAvailableFeesForCustomer(customerId)).resolves.toEqual([]);
    });
  });
});
