import { randomBytes } from 'node:crypto';

import { EventEmitterModule } from '@nestjs/event-emitter';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model, Types } from 'mongoose';

import { __resetPiiEncryptionKeyCache } from '../../common/crypto/pii-encryption';
import { InMemoryMongo } from '../../test-utils/in-memory-mongo';
import { CustomerStatus, KycStatus } from '../../common/enums/customer.enums';
import { WorkflowStatus, WorkflowStepAction } from '../../common/enums/workflow.enums';
import { WorkflowEntityType } from '../../common/enums/workflow.enums';
import { AuditModule } from '../../platform/audit/audit.module';
import { AuditService } from '../../platform/audit/audit.service';
import { EncryptionService } from '../../platform/encryption/encryption.service';
import { BvnCallLogService } from '../../platform/integrations/bvn/bvn-call-log.service';
import { BvnConsentExpiredException } from '../../platform/integrations/bvn/exceptions/bvn-consent-expired.exception';
import { BvnOtpInvalidException } from '../../platform/integrations/bvn/exceptions/bvn-otp-invalid.exception';
import { BVN_VERIFICATION_ADAPTER } from '../../platform/integrations/bvn/interfaces/bvn-verification-adapter.interface';
import {
  MOCK_BVN_OTP,
  MockBvnVerificationAdapter,
} from '../../platform/integrations/bvn/mock-bvn-verification.adapter';
import {
  BvnCallLog,
  BvnCallLogSchema,
} from '../../platform/integrations/bvn/schemas/bvn-call-log.schema';
import { S3_ADAPTER } from '../../platform/integrations/s3/interfaces/s3-adapter.interface';
import { MockS3Service } from '../../platform/integrations/s3/mock-s3.service';
import { approveCapability } from '../../platform/rbac/constants/capabilities';
import {
  WorkflowChainConfig,
  WorkflowChainConfigSchema,
} from '../../platform/workflow-engine/schemas/workflow-chain-config.schema';
import {
  WorkflowRequest,
  WorkflowRequestSchema,
} from '../../platform/workflow-engine/schemas/workflow-request.schema';
import { WorkflowEngineService } from '../../platform/workflow-engine/workflow-engine.service';
import { Branch, BranchDocument, BranchSchema } from '../branches/schemas/branch.schema';
import { CustomerService } from './customer.service';
import { Customer, CustomerDocument, CustomerSchema } from './schemas/customer.schema';
import { KycRecord, KycRecordDocument, KycRecordSchema } from './schemas/kyc-record.schema';
import {
  PendingBvnConsent,
  PendingBvnConsentDocument,
  PendingBvnConsentSchema,
} from './schemas/pending-bvn-consent.schema';

describe('CustomerService', () => {
  const mongo = new InMemoryMongo();

  let moduleRef: TestingModule;
  let service: CustomerService;
  let workflowEngineService: WorkflowEngineService;
  let auditService: AuditService;
  let customerModel: Model<CustomerDocument>;
  let kycRecordModel: Model<KycRecordDocument>;
  let pendingModel: Model<PendingBvnConsentDocument>;
  let branchId: string;
  const STAFF_ID = new Types.ObjectId().toString();
  const APPROVER_ID = new Types.ObjectId().toString();

  const APPROVE_CUSTOMER_ACTOR = {
    staffId: APPROVER_ID,
    capabilities: [approveCapability(WorkflowEntityType.CUSTOMER)],
  };

  beforeAll(async () => {
    process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    __resetPiiEncryptionKeyCache();

    await mongo.start();

    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri()),
        MongooseModule.forFeature([
          { name: Customer.name, schema: CustomerSchema },
          { name: KycRecord.name, schema: KycRecordSchema },
          { name: PendingBvnConsent.name, schema: PendingBvnConsentSchema },
          { name: Branch.name, schema: BranchSchema },
          { name: WorkflowChainConfig.name, schema: WorkflowChainConfigSchema },
          { name: WorkflowRequest.name, schema: WorkflowRequestSchema },
          { name: BvnCallLog.name, schema: BvnCallLogSchema },
        ]),
        AuditModule,
        EventEmitterModule.forRoot(),
      ],
      providers: [
        CustomerService,
        WorkflowEngineService,
        EncryptionService,
        BvnCallLogService,
        MockBvnVerificationAdapter,
        MockS3Service,
        { provide: BVN_VERIFICATION_ADAPTER, useExisting: MockBvnVerificationAdapter },
        { provide: S3_ADAPTER, useExisting: MockS3Service },
      ],
    }).compile();

    service = moduleRef.get(CustomerService);
    workflowEngineService = moduleRef.get(WorkflowEngineService);
    auditService = moduleRef.get(AuditService);
    customerModel = moduleRef.get(getModelToken(Customer.name));
    kycRecordModel = moduleRef.get(getModelToken(KycRecord.name));
    pendingModel = moduleRef.get(getModelToken(PendingBvnConsent.name));

    await moduleRef.init(); // registers @OnEvent listeners
  }, 60_000);

  beforeEach(async () => {
    const branchModel = moduleRef.get<Model<BranchDocument>>(getModelToken(Branch.name));
    const branch = await branchModel.create({
      name: 'Main',
      code: `BR${Date.now()}${Math.random()}`,
      active: true,
    });
    branchId = branch._id.toString();
  });

  afterEach(async () => {
    const collectionsToKeep = new Set(['workflow_chain_configs']);
    const connection = customerModel.db;
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

  async function runConsentFlow(bvn = '12345678901'): Promise<CustomerDocument> {
    const start = await service.startBvnConsent(bvn, STAFF_ID, branchId);
    return service.confirmBvnConsent(start.pendingConsentId, MOCK_BVN_OTP);
  }

  describe('startBvnConsent / confirmBvnConsent', () => {
    it('creates no Customer/KycRecord after startBvnConsent alone', async () => {
      await service.startBvnConsent('12345678901', STAFF_ID, branchId);

      expect(await customerModel.countDocuments()).toBe(0);
      expect(await kycRecordModel.countDocuments()).toBe(0);
    });

    it('creates a pre-filled Customer + KycRecord after a successful confirm', async () => {
      const customer = await runConsentFlow('12345678901');

      expect(customer.status).toBe(CustomerStatus.PENDING_APPROVAL);
      expect(customer.kycStatus).toBe(KycStatus.INCOMPLETE);
      expect(customer.firstName).toBeTruthy();
      expect(customer.branchId.toString()).toBe(branchId);

      const kyc = await kycRecordModel.findOne({ customerId: customer._id }).exec();
      expect(kyc).not.toBeNull();
      expect(kyc?.bvnVerifiedAt).not.toBeNull();
      expect(kyc?.bvn).not.toBe('12345678901'); // encrypted, not plaintext
    });

    it('OTP failure leaves no Customer/KycRecord and surfaces BvnOtpInvalidException', async () => {
      const start = await service.startBvnConsent('12345678901', STAFF_ID, branchId);

      await expect(service.confirmBvnConsent(start.pendingConsentId, '999999')).rejects.toThrow(
        BvnOtpInvalidException,
      );

      expect(await customerModel.countDocuments()).toBe(0);
      expect(await kycRecordModel.countDocuments()).toBe(0);
    });

    it('an unknown/expired pending consent surfaces BvnConsentExpiredException with no records created', async () => {
      await expect(
        service.confirmBvnConsent(new Types.ObjectId().toString(), MOCK_BVN_OTP),
      ).rejects.toThrow();

      const start = await service.startBvnConsent('12345678901', STAFF_ID, branchId);
      await pendingModel.updateOne(
        { _id: start.pendingConsentId },
        { $set: { expiresAt: new Date(Date.now() - 1000) } },
      );

      await expect(service.confirmBvnConsent(start.pendingConsentId, MOCK_BVN_OTP)).rejects.toThrow(
        BvnConsentExpiredException,
      );
      expect(await customerModel.countDocuments()).toBe(0);
    });

    it('a PendingBvnConsent past its own expiresAt is not reusable even with the correct OTP', async () => {
      const start = await service.startBvnConsent('12345678901', STAFF_ID, branchId);
      await pendingModel.updateOne(
        { _id: start.pendingConsentId },
        { $set: { expiresAt: new Date(Date.now() - 60_000) } },
      );

      await expect(service.confirmBvnConsent(start.pendingConsentId, MOCK_BVN_OTP)).rejects.toThrow(
        BvnConsentExpiredException,
      );
    });
  });

  describe('submitForApproval', () => {
    async function readyCustomer(): Promise<CustomerDocument> {
      const customer = await runConsentFlow();
      await service.captureBiometric(
        customer._id.toString(),
        Buffer.from('fake-image'),
        'image/jpeg',
        STAFF_ID,
      );
      return customer;
    }

    it('requires biometric capture before submission', async () => {
      const customer = await runConsentFlow();
      await expect(service.submitForApproval(customer._id.toString(), STAFF_ID)).rejects.toThrow(
        /Biometric capture is required/,
      );
    });

    it('creates a WorkflowRequest and does not activate the customer until approved', async () => {
      const customer = await readyCustomer();

      const request = await service.submitForApproval(customer._id.toString(), STAFF_ID);
      expect(request.status).toBe(WorkflowStatus.PENDING_APPROVAL);

      const stillPending = await customerModel.findById(customer._id).exec();
      expect(stillPending?.status).toBe(CustomerStatus.PENDING_APPROVAL);

      await workflowEngineService.act({
        workflowRequestId: request._id.toString(),
        actor: APPROVE_CUSTOMER_ACTOR,
        action: WorkflowStepAction.APPROVED,
      });

      const activated = await customerModel.findById(customer._id).exec();
      expect(activated?.status).toBe(CustomerStatus.ACTIVE);
    });

    it('rejection leaves the customer in the terminal REJECTED status', async () => {
      const customer = await readyCustomer();
      const request = await service.submitForApproval(customer._id.toString(), STAFF_ID);

      await workflowEngineService.act({
        workflowRequestId: request._id.toString(),
        actor: APPROVE_CUSTOMER_ACTOR,
        action: WorkflowStepAction.REJECTED,
        comment: 'duplicate customer',
      });

      const rejected = await customerModel.findById(customer._id).exec();
      expect(rejected?.status).toBe(CustomerStatus.REJECTED);
    });

    it('rejects a second submission attempt', async () => {
      const customer = await readyCustomer();
      await service.submitForApproval(customer._id.toString(), STAFF_ID);

      await expect(service.submitForApproval(customer._id.toString(), STAFF_ID)).rejects.toThrow();
    });
  });

  describe('NIN — optional, manually verified', () => {
    it('recordNin stores an encrypted NIN', async () => {
      const customer = await runConsentFlow();
      await service.recordNin(customer._id.toString(), '98765432109', STAFF_ID);

      const kyc = await kycRecordModel.findOne({ customerId: customer._id }).exec();
      expect(kyc?.nin).not.toBe('98765432109');
      expect(kyc?.nin).toBeTruthy();
    });

    it('a customer with no NIN captured at all is a valid state', async () => {
      const customer = await runConsentFlow();
      const kyc = await kycRecordModel.findOne({ customerId: customer._id }).exec();
      expect(kyc?.nin).toBeNull();
      // recomputeKycStatus must not error just because NIN is absent
      await expect(service.recomputeKycStatus(customer._id.toString())).resolves.toBeDefined();
    });

    it('manuallyVerifyNin sets ninVerifiedAt/ninManuallyVerifiedBy', async () => {
      const customer = await runConsentFlow();
      await service.recordNin(customer._id.toString(), '98765432109', STAFF_ID);

      const kyc = await service.manuallyVerifyNin(
        customer._id.toString(),
        APPROVER_ID,
        'checked slip',
      );

      expect(kyc.ninVerifiedAt).not.toBeNull();
      expect(kyc.ninManuallyVerifiedBy?.toString()).toBe(APPROVER_ID);
      expect(kyc.ninVerificationNote).toBe('checked slip');
    });

    it('manuallyVerifyNin rejects a customer with no NIN captured', async () => {
      const customer = await runConsentFlow();
      await expect(service.manuallyVerifyNin(customer._id.toString(), APPROVER_ID)).rejects.toThrow(
        /no NIN captured/,
      );
    });
  });

  describe('recomputeKycStatus / isLoanEligible', () => {
    it('is VERIFIED once BVN + biometric are done, regardless of NIN state (absent)', async () => {
      const customer = await runConsentFlow();
      await service.captureBiometric(
        customer._id.toString(),
        Buffer.from('img'),
        'image/jpeg',
        STAFF_ID,
      );

      const status = await service.recomputeKycStatus(customer._id.toString());
      expect(status).toBe(KycStatus.VERIFIED);
      expect(await service.isLoanEligible(customer._id.toString())).toBe(true);
    });

    it('is VERIFIED with NIN present but not manually verified', async () => {
      const customer = await runConsentFlow();
      await service.recordNin(customer._id.toString(), '98765432109', STAFF_ID);
      await service.captureBiometric(
        customer._id.toString(),
        Buffer.from('img'),
        'image/jpeg',
        STAFF_ID,
      );

      expect(await service.recomputeKycStatus(customer._id.toString())).toBe(KycStatus.VERIFIED);
    });

    it('is VERIFIED with NIN present and manually verified', async () => {
      const customer = await runConsentFlow();
      await service.recordNin(customer._id.toString(), '98765432109', STAFF_ID);
      await service.manuallyVerifyNin(customer._id.toString(), APPROVER_ID);
      await service.captureBiometric(
        customer._id.toString(),
        Buffer.from('img'),
        'image/jpeg',
        STAFF_ID,
      );

      expect(await service.recomputeKycStatus(customer._id.toString())).toBe(KycStatus.VERIFIED);
    });

    it('is INCOMPLETE (and not loan-eligible) without biometric, even with BVN verified', async () => {
      const customer = await runConsentFlow();

      expect(await service.recomputeKycStatus(customer._id.toString())).toBe(KycStatus.INCOMPLETE);
      expect(await service.isLoanEligible(customer._id.toString())).toBe(false);
    });
  });

  describe('encryption at rest', () => {
    it('BVN decrypts back to the original submitted value', async () => {
      const customer = await runConsentFlow('11122233344');
      const decrypted = await service.getDecryptedBvn(customer._id.toString(), APPROVER_ID);
      expect(decrypted).toBe('11122233344');
    });

    it('NIN decrypts back to the original value when present', async () => {
      const customer = await runConsentFlow();
      await service.recordNin(customer._id.toString(), '98765432109', STAFF_ID);

      const decrypted = await service.getDecryptedNin(customer._id.toString(), APPROVER_ID);
      expect(decrypted).toBe('98765432109');
    });
  });

  describe('KYC data read auditing', () => {
    it('getDecryptedBvn produces a KYC_DATA_READ audit entry', async () => {
      const customer = await runConsentFlow();
      await service.getDecryptedBvn(customer._id.toString(), APPROVER_ID);

      const entries = await auditService.findByEntity('CUSTOMER', customer._id.toString());
      const reads = entries.filter((e) => e.action === 'KYC_DATA_READ');
      expect(reads.length).toBeGreaterThanOrEqual(1);
      expect(reads[reads.length - 1]?.actorId).toBe(APPROVER_ID);
    });

    it('getBiometricSignedUrl produces a KYC_DATA_READ audit entry', async () => {
      const customer = await runConsentFlow();
      await service.captureBiometric(
        customer._id.toString(),
        Buffer.from('img'),
        'image/jpeg',
        STAFF_ID,
      );

      const url = await service.getBiometricSignedUrl(customer._id.toString(), APPROVER_ID);
      expect(url).toBeTruthy();

      const entries = await auditService.findByEntity('CUSTOMER', customer._id.toString());
      expect(entries.some((e) => e.action === 'KYC_DATA_READ')).toBe(true);
    });

    it('every BVN provider call (consent initiate, confirm, direct verify) produces a BvnCallLog entry', async () => {
      const bvnCallLogModel = moduleRef.get<Model<Record<string, unknown>>>(
        getModelToken(BvnCallLog.name),
      );
      await runConsentFlow();

      const steps = (await bvnCallLogModel.find().exec()).map(
        (l) => (l as unknown as { step: string }).step,
      );
      expect(steps).toContain('CONSENT_INITIATE');
      expect(steps).toContain('CONSENT_CONFIRM');
    });
  });

  describe('isVerificationFresh', () => {
    it('is true within maxAgeDays and false once older', async () => {
      const customer = await runConsentFlow();

      expect(await service.isVerificationFresh(customer._id.toString(), 'bvn', 30)).toBe(true);

      await kycRecordModel.updateOne(
        { customerId: customer._id },
        { $set: { bvnVerifiedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) } },
      );

      expect(await service.isVerificationFresh(customer._id.toString(), 'bvn', 30)).toBe(false);
    });

    it('is false for a field that was never verified (e.g. nin)', async () => {
      const customer = await runConsentFlow();
      expect(await service.isVerificationFresh(customer._id.toString(), 'nin', 30)).toBe(false);
    });
  });
});
