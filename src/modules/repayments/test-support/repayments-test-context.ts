import { randomBytes } from 'node:crypto';

import { EventEmitterModule } from '@nestjs/event-emitter';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model, Types } from 'mongoose';

import { __resetPiiEncryptionKeyCache } from '../../../common/crypto/pii-encryption';
import { CustomerStatus, KycStatus } from '../../../common/enums/customer.enums';
import {
  FeeAppliesTo,
  FeeCalcType,
  FeeCategory,
  FeeTiming,
  InterestType,
  PenaltyFrequency,
} from '../../../common/enums/loan-product.enums';
import { DisbursementChannel } from '../../../common/enums/loan.enums';
import { RepaymentChannel } from '../../../common/enums/repayment.enums';
import { WorkflowEntityType, WorkflowStepAction } from '../../../common/enums/workflow.enums';
import { InMemoryMongo } from '../../../test-utils/in-memory-mongo';
import { testAwsConfigModule } from '../../../test-utils/test-aws-config.module';
import { AuditModule } from '../../../platform/audit/audit.module';
import { AuditLog, AuditLogDocument } from '../../../platform/audit/schemas/audit-log.schema';
import { EncryptionService } from '../../../platform/encryption/encryption.service';
import { BvnCallLogService } from '../../../platform/integrations/bvn/bvn-call-log.service';
import { BVN_VERIFICATION_ADAPTER } from '../../../platform/integrations/bvn/interfaces/bvn-verification-adapter.interface';
import { MockBvnVerificationAdapter } from '../../../platform/integrations/bvn/mock-bvn-verification.adapter';
import {
  BvnCallLog,
  BvnCallLogSchema,
} from '../../../platform/integrations/bvn/schemas/bvn-call-log.schema';
import { FaceComparisonCallLogService } from '../../../platform/integrations/rekognition/face-comparison-call-log.service';
import { FACE_COMPARISON_ADAPTER } from '../../../platform/integrations/rekognition/interfaces/face-comparison-adapter.interface';
import { MockRekognitionAdapter } from '../../../platform/integrations/rekognition/mock-rekognition.adapter';
import {
  FaceComparisonCallLog,
  FaceComparisonCallLogSchema,
} from '../../../platform/integrations/rekognition/schemas/face-comparison-call-log.schema';
import { S3_ADAPTER } from '../../../platform/integrations/s3/interfaces/s3-adapter.interface';
import { MockS3Service } from '../../../platform/integrations/s3/mock-s3.service';
import { approveCapability, reviewCapability } from '../../../platform/rbac/constants/capabilities';
import { ActingStaff } from '../../../platform/workflow-engine/interfaces/workflow-engine.interfaces';
import {
  WorkflowChainConfig,
  WorkflowChainConfigSchema,
} from '../../../platform/workflow-engine/schemas/workflow-chain-config.schema';
import {
  WorkflowRequest,
  WorkflowRequestDocument,
  WorkflowRequestSchema,
} from '../../../platform/workflow-engine/schemas/workflow-request.schema';
import { WorkflowEngineService } from '../../../platform/workflow-engine/workflow-engine.service';
import { BranchFundBalanceService } from '../../branches/branch-fund-balance.service';
import { BranchBankAccountPurpose } from '../../../common/enums/branch.enums';
import {
  BranchBankAccount,
  BranchBankAccountDocument,
  BranchBankAccountSchema,
} from '../../branches/schemas/branch-bank-account.schema';
import {
  BranchFundBalance,
  BranchFundBalanceSchema,
} from '../../branches/schemas/branch-fund-balance.schema';
import { Branch, BranchDocument, BranchSchema } from '../../branches/schemas/branch.schema';
import { CustomerService } from '../../customers/customer.service';
import {
  BvnVerificationPreview,
  BvnVerificationPreviewSchema,
} from '../../customers/schemas/bvn-verification-preview.schema';
import {
  Customer,
  CustomerDocument,
  CustomerSchema,
} from '../../customers/schemas/customer.schema';
import { KycRecord, KycRecordSchema } from '../../customers/schemas/kyc-record.schema';
import { Staff, StaffSchema } from '../../identity/schemas/staff.schema';
import { CreateFeeDefinitionDto } from '../../loan-products/dto/create-fee-definition.dto';
import { CreateLoanProductDto } from '../../loan-products/dto/create-loan-product.dto';
import { FeeDefinitionsService } from '../../loan-products/fee-definitions.service';
import { LoanProductsService } from '../../loan-products/loan-products.service';
import {
  FeeDefinition,
  FeeDefinitionDocument,
  FeeDefinitionSchema,
} from '../../loan-products/schemas/fee-definition.schema';
import {
  LoanProduct,
  LoanProductDocument,
  LoanProductSchema,
} from '../../loan-products/schemas/loan-product.schema';
import { GroupsService } from '../../groups/groups.service';
import { LOAN_STATUS_PORT } from '../../groups/interfaces/loan-status-port.interface';
import {
  GroupMembership,
  GroupMembershipSchema,
} from '../../groups/schemas/group-membership.schema';
import { Group, GroupDocument, GroupSchema } from '../../groups/schemas/group.schema';
import { StubBankTransferPort } from '../../loans/bank-transfer/stub-bank-transfer.port';
import { FeePaymentsService } from '../../loans/fee-payments.service';
import { BANK_TRANSFER_PORT } from '../../loans/interfaces/bank-transfer-port.interface';
import { LEDGER_POSTING_PORT } from '../../loans/interfaces/ledger-posting-port.interface';
import { NOTIFICATION_PORT } from '../../loans/interfaces/notification-port.interface';
import { StubLedgerPostingPort } from '../../loans/ledger/stub-ledger-posting.port';
import { LoanConsentService } from '../../loans/loan-consent.service';
import { LoanVerificationService } from '../../loans/loan-verification.service';
import { LoansService } from '../../loans/loans.service';
import { PendingNotificationLogPort } from '../../loans/notifications/pending-notification-log.port';
import {
  LoanConsentChallenge,
  LoanConsentChallengeSchema,
} from '../../loans/schemas/loan-consent-challenge.schema';
import {
  PendingNotificationLog,
  PendingNotificationLogDocument,
  PendingNotificationLogSchema,
} from '../../notifications/schemas/pending-notification-log.schema';
import {
  DisbursementVerification,
  DisbursementVerificationSchema,
} from '../../loans/schemas/disbursement-verification.schema';
import { FeePayment, FeePaymentSchema } from '../../loans/schemas/fee-payment.schema';
import {
  MemberLoanAccount,
  MemberLoanAccountDocument,
  MemberLoanAccountSchema,
} from '../../loans/schemas/member-loan-account.schema';
import { Loan, LoanDocument, LoanSchema } from '../../loans/schemas/loan.schema';
import { CustomerRiskService } from '../customer-risk.service';
import { EarlyLiquidationService } from '../early-liquidation.service';
import { LoanDetailService } from '../loan-detail.service';
import { PenaltySweepService } from '../penalty-sweep.service';
import { RepaymentsService } from '../repayments.service';
import {
  EarlyLiquidationRequest,
  EarlyLiquidationRequestDocument,
  EarlyLiquidationRequestSchema,
} from '../schemas/early-liquidation-request.schema';
import {
  LiquidationDelayCharge,
  LiquidationDelayChargeDocument,
  LiquidationDelayChargeSchema,
} from '../schemas/liquidation-delay-charge.schema';
import {
  PenaltyCharge,
  PenaltyChargeDocument,
  PenaltyChargeSchema,
} from '../schemas/penalty-charge.schema';
import {
  RepaymentRecord,
  RepaymentRecordDocument,
  RepaymentRecordSchema,
} from '../schemas/repayment-record.schema';

/**
 * Shared test scaffolding for Phase 9's three spec files
 * (repayments.service.spec.ts, early-liquidation.service.spec.ts,
 * penalty-sweep.service.spec.ts) — the full dependency graph up through a
 * disbursed loan is identical across all three (branch -> funded ->
 * customers -> group -> product+fee -> loan raised/approved/verified/
 * disbursed), so it's built once here rather than tripled. Each spec file
 * still gets its own isolated InMemoryMongo instance/TestingModule — this
 * only shares the *setup code*, not a runtime instance across files. See
 * PHASE_9_NOTES.md.
 */
export interface RepaymentsTestContext {
  moduleRef: TestingModule;
  mongo: InMemoryMongo;

  repaymentsService: RepaymentsService;
  earlyLiquidationService: EarlyLiquidationService;
  penaltySweepService: PenaltySweepService;
  customerRiskService: CustomerRiskService;
  loanDetailService: LoanDetailService;
  loansService: LoansService;
  loanConsentService: LoanConsentService;
  loanVerificationService: LoanVerificationService;
  groupsService: GroupsService;
  loanProductsService: LoanProductsService;
  feeDefinitionsService: FeeDefinitionsService;
  customerService: CustomerService;
  workflowEngineService: WorkflowEngineService;
  branchFundBalanceService: BranchFundBalanceService;
  stubLedgerPostingPort: StubLedgerPostingPort;
  pendingNotificationLogPort: PendingNotificationLogPort;

  repaymentRecordModel: Model<RepaymentRecordDocument>;
  penaltyChargeModel: Model<PenaltyChargeDocument>;
  earlyLiquidationRequestModel: Model<EarlyLiquidationRequestDocument>;
  liquidationDelayChargeModel: Model<LiquidationDelayChargeDocument>;
  memberLoanAccountModel: Model<MemberLoanAccountDocument>;
  loanModel: Model<LoanDocument>;
  groupModel: Model<GroupDocument>;
  branchModel: Model<BranchDocument>;
  branchBankAccountModel: Model<BranchBankAccountDocument>;
  customerModel: Model<CustomerDocument>;
  loanProductModel: Model<LoanProductDocument>;
  feeDefinitionModel: Model<FeeDefinitionDocument>;
  workflowRequestModel: Model<WorkflowRequestDocument>;
  pendingNotificationLogModel: Model<PendingNotificationLogDocument>;
  auditLogModel: Model<AuditLogDocument>;

  branchId: string;
  branchBankAccountId: string;

  INITIATOR_ID: string;
  REVIEWER_ID: string;
  APPROVER_ID: string;
  LOAN_APPROVER_ID: string;
  REPAYMENT_REVIEWER_ID: string;
  REPAYMENT_APPROVER_ID: string;
  ADMIN_ID: string;
}

export async function createRepaymentsTestContext(): Promise<RepaymentsTestContext> {
  process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  __resetPiiEncryptionKeyCache();

  const mongo = new InMemoryMongo();
  await mongo.start();

  const moduleRef = await Test.createTestingModule({
    imports: [
      MongooseModule.forRoot(mongo.getUri()),
      MongooseModule.forFeature([
        { name: RepaymentRecord.name, schema: RepaymentRecordSchema },
        { name: PenaltyCharge.name, schema: PenaltyChargeSchema },
        { name: EarlyLiquidationRequest.name, schema: EarlyLiquidationRequestSchema },
        { name: LiquidationDelayCharge.name, schema: LiquidationDelayChargeSchema },
        { name: Loan.name, schema: LoanSchema },
        { name: MemberLoanAccount.name, schema: MemberLoanAccountSchema },
        { name: DisbursementVerification.name, schema: DisbursementVerificationSchema },
        { name: FeePayment.name, schema: FeePaymentSchema },
        { name: Group.name, schema: GroupSchema },
        { name: GroupMembership.name, schema: GroupMembershipSchema },
        { name: Branch.name, schema: BranchSchema },
        { name: BranchBankAccount.name, schema: BranchBankAccountSchema },
        { name: BranchFundBalance.name, schema: BranchFundBalanceSchema },
        { name: Customer.name, schema: CustomerSchema },
        { name: Staff.name, schema: StaffSchema },
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
      RepaymentsService,
      EarlyLiquidationService,
      PenaltySweepService,
      CustomerRiskService,
      LoanDetailService,
      LoansService,
      LoanConsentService,
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
      { provide: LOAN_STATUS_PORT, useValue: { hasPendingLoan: () => Promise.resolve(false) } },
    ],
  }).compile();

  const ctx: RepaymentsTestContext = {
    moduleRef,
    mongo,
    repaymentsService: moduleRef.get(RepaymentsService),
    earlyLiquidationService: moduleRef.get(EarlyLiquidationService),
    penaltySweepService: moduleRef.get(PenaltySweepService),
    customerRiskService: moduleRef.get(CustomerRiskService),
    loanDetailService: moduleRef.get(LoanDetailService),
    loansService: moduleRef.get(LoansService),
    loanConsentService: moduleRef.get(LoanConsentService),
    loanVerificationService: moduleRef.get(LoanVerificationService),
    groupsService: moduleRef.get(GroupsService),
    loanProductsService: moduleRef.get(LoanProductsService),
    feeDefinitionsService: moduleRef.get(FeeDefinitionsService),
    customerService: moduleRef.get(CustomerService),
    workflowEngineService: moduleRef.get(WorkflowEngineService),
    branchFundBalanceService: moduleRef.get(BranchFundBalanceService),
    stubLedgerPostingPort: moduleRef.get(StubLedgerPostingPort),
    pendingNotificationLogPort: moduleRef.get(PendingNotificationLogPort),

    repaymentRecordModel: moduleRef.get(getModelToken(RepaymentRecord.name)),
    penaltyChargeModel: moduleRef.get(getModelToken(PenaltyCharge.name)),
    earlyLiquidationRequestModel: moduleRef.get(getModelToken(EarlyLiquidationRequest.name)),
    liquidationDelayChargeModel: moduleRef.get(getModelToken(LiquidationDelayCharge.name)),
    memberLoanAccountModel: moduleRef.get(getModelToken(MemberLoanAccount.name)),
    loanModel: moduleRef.get(getModelToken(Loan.name)),
    groupModel: moduleRef.get(getModelToken(Group.name)),
    branchModel: moduleRef.get(getModelToken(Branch.name)),
    branchBankAccountModel: moduleRef.get(getModelToken(BranchBankAccount.name)),
    customerModel: moduleRef.get(getModelToken(Customer.name)),
    loanProductModel: moduleRef.get(getModelToken(LoanProduct.name)),
    feeDefinitionModel: moduleRef.get(getModelToken(FeeDefinition.name)),
    workflowRequestModel: moduleRef.get(getModelToken(WorkflowRequest.name)),
    pendingNotificationLogModel: moduleRef.get(getModelToken(PendingNotificationLog.name)),
    auditLogModel: moduleRef.get(getModelToken(AuditLog.name)),

    branchId: '',
    branchBankAccountId: '',

    INITIATOR_ID: new Types.ObjectId().toString(),
    REVIEWER_ID: new Types.ObjectId().toString(),
    APPROVER_ID: new Types.ObjectId().toString(),
    LOAN_APPROVER_ID: new Types.ObjectId().toString(),
    REPAYMENT_REVIEWER_ID: new Types.ObjectId().toString(),
    REPAYMENT_APPROVER_ID: new Types.ObjectId().toString(),
    ADMIN_ID: new Types.ObjectId().toString(),
  };

  await moduleRef.init();
  return ctx;
}

export async function teardownRepaymentsTestContext(ctx: RepaymentsTestContext): Promise<void> {
  await ctx.moduleRef.close();
  await ctx.mongo.stop();
}

export async function resetBranchFixture(
  ctx: RepaymentsTestContext,
  fundKobo = 1_000_000_000,
): Promise<void> {
  const branch = await ctx.branchModel.create({
    name: 'Main',
    code: `BR${Date.now()}${Math.random()}`,
    active: true,
  });
  ctx.branchId = branch._id.toString();
  await ctx.branchFundBalanceService.credit(ctx.branchId, fundKobo);

  const bankAccount = await ctx.branchBankAccountModel.create({
    branchId: branch._id,
    bankName: 'Test Bank',
    accountNumber: `${Date.now()}${Math.floor(Math.random() * 1000)}`,
    accountName: 'Main Branch Collections',
    purpose: BranchBankAccountPurpose.REPAYMENT_COLLECTION,
    active: true,
  });
  ctx.branchBankAccountId = bankAccount._id.toString();
}

export async function clearAllExceptChainConfigs(ctx: RepaymentsTestContext): Promise<void> {
  const collectionsToKeep = new Set(['workflow_chain_configs']);
  const connection = ctx.loanModel.db;
  const collections = await connection.db!.collections();
  await Promise.all(
    collections
      .filter((c) => !collectionsToKeep.has(c.collectionName))
      .map((c) => c.deleteMany({})),
  );
}

let customerCounter = 0;

export async function createCustomer(
  ctx: RepaymentsTestContext,
  kycStatus: KycStatus = KycStatus.VERIFIED,
): Promise<string> {
  customerCounter += 1;
  const customer = await ctx.customerModel.create({
    firstName: 'Test',
    lastName: `Customer${customerCounter}`,
    phoneNumber: `0800${customerCounter}${Date.now()}`.slice(0, 15),
    branchId: ctx.branchId,
    status: CustomerStatus.ACTIVE,
    kycStatus,
    createdBy: ctx.INITIATOR_ID,
  });
  return customer._id.toString();
}

/**
 * Also fast-forwards `status` straight to ACTIVE (bypassing the customer's
 * own review/approve workflow, not what these repayment-focused tests
 * exercise) — GroupsService's pre-approval validator now requires every
 * proposed member to be an ACTIVE customer before a group can be approved,
 * and every caller here immediately builds a group out of these customers.
 */
export async function createVerifiedCustomerWithBiometrics(
  ctx: RepaymentsTestContext,
): Promise<string> {
  customerCounter += 1;
  const bvn = `${10_000_000_000 + customerCounter}`.slice(0, 11);
  const { customer } = await ctx.customerService.verifyBvnAndCreateCustomer(
    bvn,
    ctx.branchId,
    ctx.INITIATOR_ID,
  );
  await ctx.customerService.captureBiometric(
    customer._id.toString(),
    Buffer.from(`biometric-${customerCounter}`),
    'image/jpeg',
    ctx.INITIATOR_ID,
  );
  await ctx.customerModel.updateOne({ _id: customer._id }, { $set: { status: CustomerStatus.ACTIVE } }).exec();
  return customer._id.toString();
}

export async function createApprovedGroup(
  ctx: RepaymentsTestContext,
  factory: (ctx: RepaymentsTestContext) => Promise<string> = createCustomer,
  n = 3,
): Promise<{ groupId: string; customerIds: string[] }> {
  const customerIds: string[] = [];
  for (let i = 0; i < n; i += 1) {
    customerIds.push(await factory(ctx));
  }
  const name = `Group-${Date.now()}-${Math.random()}`;
  const request = await ctx.groupsService.initiateCreation(
    { name, branchId: ctx.branchId, proposedMemberCustomerIds: customerIds },
    ctx.INITIATOR_ID,
  );
  await ctx.workflowEngineService.act({
    workflowRequestId: request._id.toString(),
    actor: { staffId: ctx.REVIEWER_ID, capabilities: [reviewCapability(WorkflowEntityType.GROUP)] },
    action: WorkflowStepAction.APPROVED,
  });
  await ctx.workflowEngineService.act({
    workflowRequestId: request._id.toString(),
    actor: {
      staffId: ctx.APPROVER_ID,
      capabilities: [approveCapability(WorkflowEntityType.GROUP)],
    },
    action: WorkflowStepAction.APPROVED,
  });
  const group = await ctx.groupModel.findOne({ name }).exec();
  if (!group) {
    throw new Error(`createApprovedGroup: no Group named ${name} found after approval`);
  }
  return { groupId: group._id.toString(), customerIds };
}

export function feeDto(overrides: Partial<CreateFeeDefinitionDto> = {}): CreateFeeDefinitionDto {
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

export async function createApprovedFee(
  ctx: RepaymentsTestContext,
  overrides: Partial<CreateFeeDefinitionDto> = {},
): Promise<string> {
  const dto = feeDto(overrides);
  const request = await ctx.feeDefinitionsService.initiateCreation(dto, ctx.INITIATOR_ID);
  await ctx.workflowEngineService.act({
    workflowRequestId: request._id.toString(),
    actor: {
      staffId: ctx.APPROVER_ID,
      capabilities: [approveCapability(WorkflowEntityType.FEE_DEFINITION)],
    },
    action: WorkflowStepAction.APPROVED,
  });
  const created = await ctx.feeDefinitionModel.findOne({ name: dto.name }).exec();
  return created!._id.toString();
}

export function productDto(overrides: Partial<CreateLoanProductDto> = {}): CreateLoanProductDto {
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
      gracePeriodDays: 0,
      frequency: PenaltyFrequency.ONE_TIME,
    },
    ...overrides,
  };
}

export async function createApprovedProduct(
  ctx: RepaymentsTestContext,
  overrides: Partial<CreateLoanProductDto> = {},
): Promise<LoanProductDocument> {
  const dto = productDto(overrides);
  const request = await ctx.loanProductsService.initiateCreation(dto, ctx.INITIATOR_ID);
  await ctx.workflowEngineService.act({
    workflowRequestId: request._id.toString(),
    actor: {
      staffId: ctx.APPROVER_ID,
      capabilities: [approveCapability(WorkflowEntityType.LOAN_PRODUCT)],
    },
    action: WorkflowStepAction.APPROVED,
  });
  const created = await ctx.loanProductModel.findOne({ name: dto.name }).exec();
  return created!;
}

export async function approveLoan(ctx: RepaymentsTestContext, loanId: string): Promise<void> {
  const requests = await ctx.workflowRequestModel
    .find({ entityType: WorkflowEntityType.LOAN, entityId: loanId })
    .exec();
  const request = requests[0];
  if (!request) {
    throw new Error(`No LOAN WorkflowRequest found for loan ${loanId}`);
  }
  await ctx.workflowEngineService.act({
    workflowRequestId: request._id.toString(),
    actor: {
      staffId: ctx.LOAN_APPROVER_ID,
      capabilities: [approveCapability(WorkflowEntityType.LOAN)],
    },
    action: WorkflowStepAction.APPROVED,
  });
}

/**
 * The full pipeline every repayments test needs as a starting point: N
 * verified, KYC'd customers -> approved group -> approved product (+
 * optional fee) -> loan raised, approved, every member verified, and fully
 * disbursed. Returns the resulting ACTIVE MemberLoanAccounts.
 */
export async function raiseApproveVerifyAndDisburseLoan(
  ctx: RepaymentsTestContext,
  options: {
    n?: number;
    memberPrincipalKobo?: number;
    productOverrides?: Partial<CreateLoanProductDto>;
    purpose?: string;
    /** Applied to every member — defaults to TRANSFER. Set to CHEQUE_PICKUP to exercise the confirmChequeHandover/grace-buffer path. */
    disbursementChannel?: DisbursementChannel;
  } = {},
): Promise<{
  groupId: string;
  customerIds: string[];
  product: LoanProductDocument;
  loanId: string;
  memberLoanAccountIds: string[];
}> {
  const n = options.n ?? 3;
  const memberPrincipalKobo = options.memberPrincipalKobo ?? 200_000;

  const { groupId, customerIds } = await createApprovedGroup(
    ctx,
    createVerifiedCustomerWithBiometrics,
    n,
  );
  const product = await createApprovedProduct(ctx, options.productOverrides);

  // See LoansService.raiseApplication's own comment — a consent code, sent
  // to (and recovered from, via the PendingNotificationLog stub — see
  // LoanConsentService's own comment) one of the members, is required.
  const { challengeId: consentChallengeId } = await ctx.loanConsentService.issueChallenge(
    customerIds[0]!,
    ctx.INITIATOR_ID,
  );
  const consentLog = await ctx.pendingNotificationLogModel
    .findOne({ recipientCustomerId: new Types.ObjectId(customerIds[0]!) })
    .sort({ createdAt: -1 })
    .exec();
  const consentCode = (consentLog?.payload as { code?: string } | undefined)?.code;
  if (!consentCode) {
    throw new Error('raiseApproveVerifyAndDisburseLoan: no consent code found in PendingNotificationLog');
  }

  const disbursementChannel = options.disbursementChannel ?? DisbursementChannel.TRANSFER;
  const raiseResult = await ctx.loansService.raiseApplication(
    groupId,
    product._id.toString(),
    product.tenureOptions[0]!,
    customerIds.map((customerId) => ({
      customerId,
      requestedAmountKobo: memberPrincipalKobo,
      disbursementChannel,
      bankAccountDetails:
        disbursementChannel === DisbursementChannel.TRANSFER
          ? { accountName: 'Test Account', accountNumber: '0123456789', bankName: 'Test Bank' }
          : undefined,
    })),
    ctx.INITIATOR_ID,
    consentChallengeId,
    consentCode,
    options.purpose,
  );
  const loanId = raiseResult.loan._id.toString();
  await approveLoan(ctx, loanId);

  for (const customerId of customerIds) {
    await ctx.loanVerificationService.initiateMemberVerification(
      loanId,
      customerId,
      Buffer.from('live-image-ok'),
      ctx.INITIATOR_ID,
    );
  }

  const accounts = await ctx.memberLoanAccountModel
    .find({ loanId: new Types.ObjectId(loanId) })
    .exec();
  return {
    groupId,
    customerIds,
    product,
    loanId,
    memberLoanAccountIds: accounts.map((a) => a._id.toString()),
  };
}

export function repaymentReviewActor(ctx: RepaymentsTestContext): ActingStaff {
  return {
    staffId: ctx.REPAYMENT_REVIEWER_ID,
    capabilities: [reviewCapability(WorkflowEntityType.REPAYMENT_RECORD)],
  };
}

export function repaymentApproveActor(ctx: RepaymentsTestContext): ActingStaff {
  return {
    staffId: ctx.REPAYMENT_APPROVER_ID,
    capabilities: [approveCapability(WorkflowEntityType.REPAYMENT_RECORD)],
  };
}

/** Records a repayment and drives it all the way through review -> approve. Returns the (now APPROVED) record. */
export async function recordAndApproveRepayment(
  ctx: RepaymentsTestContext,
  memberLoanAccountId: string,
  amountKobo: number,
  overrides: { transactionReference?: string; paymentDate?: string } = {},
): Promise<RepaymentRecordDocument> {
  const { record, workflowRequest } = await ctx.repaymentsService.recordRepayment(
    {
      memberLoanAccountId,
      branchBankAccountId: ctx.branchBankAccountId,
      channel: RepaymentChannel.BANK_TRANSFER,
      transactionReference: overrides.transactionReference ?? `TXN-${Date.now()}-${Math.random()}`,
      amountKobo,
      paymentDate: overrides.paymentDate ?? new Date().toISOString(),
    },
    ctx.INITIATOR_ID,
  );

  await ctx.workflowEngineService.act({
    workflowRequestId: workflowRequest._id.toString(),
    actor: repaymentReviewActor(ctx),
    action: WorkflowStepAction.APPROVED,
  });
  await ctx.workflowEngineService.act({
    workflowRequestId: workflowRequest._id.toString(),
    actor: repaymentApproveActor(ctx),
    action: WorkflowStepAction.APPROVED,
  });

  const updated = await ctx.repaymentRecordModel.findById(record._id).exec();
  return updated!;
}
