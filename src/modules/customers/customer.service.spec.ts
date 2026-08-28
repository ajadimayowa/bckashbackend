import { randomBytes } from 'node:crypto';

import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model, Types } from 'mongoose';

import { __resetPiiEncryptionKeyCache } from '../../common/crypto/pii-encryption';
import { InMemoryMongo } from '../../test-utils/in-memory-mongo';
import { CustomerStatus, IdDocumentType, KycStatus } from '../../common/enums/customer.enums';
import { StaffRole } from '../../common/enums/identity.enums';
import { WorkflowStatus, WorkflowStepAction } from '../../common/enums/workflow.enums';
import { WorkflowEntityType } from '../../common/enums/workflow.enums';
import { AuditModule } from '../../platform/audit/audit.module';
import { AuditService } from '../../platform/audit/audit.service';
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
import { GroupMembership, GroupMembershipDocument, GroupMembershipSchema } from '../groups/schemas/group-membership.schema';
import { Group, GroupDocument, GroupSchema } from '../groups/schemas/group.schema';
import { Staff, StaffSchema } from '../identity/schemas/staff.schema';
import { CustomerService } from './customer.service';
import {
  BvnVerificationPreview,
  BvnVerificationPreviewDocument,
  BvnVerificationPreviewSchema,
} from './schemas/bvn-verification-preview.schema';
import { Customer, CustomerDocument, CustomerSchema, EditPrivilegeStatus } from './schemas/customer.schema';
import { KycRecord, KycRecordDocument, KycRecordSchema } from './schemas/kyc-record.schema';

describe('CustomerService', () => {
  const mongo = new InMemoryMongo();

  let moduleRef: TestingModule;
  let service: CustomerService;
  let workflowEngineService: WorkflowEngineService;
  let auditService: AuditService;
  let customerModel: Model<CustomerDocument>;
  let kycRecordModel: Model<KycRecordDocument>;
  let bvnVerificationPreviewModel: Model<BvnVerificationPreviewDocument>;
  let branchId: string;
  const STAFF_ID = new Types.ObjectId().toString();
  const REVIEWER_ID = new Types.ObjectId().toString();
  const APPROVER_ID = new Types.ObjectId().toString();

  const REVIEW_CUSTOMER_ACTOR = {
    staffId: REVIEWER_ID,
    capabilities: [reviewCapability(WorkflowEntityType.CUSTOMER)],
  };
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
        // enforceUniquePhoneNumber defaults true here — see
        // env.validation.ts/configuration.ts's own doc comments on
        // CUSTOMER_ENFORCE_UNIQUE_PHONE; the "disabled" case is exercised
        // separately below via its own module instance.
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ customers: { enforceUniquePhoneNumber: true } })],
        }),
        MongooseModule.forRoot(mongo.getUri()),
        MongooseModule.forFeature([
          { name: Customer.name, schema: CustomerSchema },
          { name: KycRecord.name, schema: KycRecordSchema },
          { name: Branch.name, schema: BranchSchema },
          { name: Staff.name, schema: StaffSchema },
          { name: Group.name, schema: GroupSchema },
          { name: GroupMembership.name, schema: GroupMembershipSchema },
          { name: WorkflowChainConfig.name, schema: WorkflowChainConfigSchema },
          { name: WorkflowRequest.name, schema: WorkflowRequestSchema },
          { name: BvnCallLog.name, schema: BvnCallLogSchema },
          { name: BvnVerificationPreview.name, schema: BvnVerificationPreviewSchema },
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
    bvnVerificationPreviewModel = moduleRef.get(getModelToken(BvnVerificationPreview.name));

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
    const result = await service.verifyBvnAndCreateCustomer(bvn, branchId, STAFF_ID);
    return result.customer;
  }

  describe('verifyBvnAndCreateCustomer', () => {
    it('creates a pre-filled Customer + KycRecord in one call', async () => {
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

    it('rejects a non-existent branch, creating nothing', async () => {
      await expect(
        service.verifyBvnAndCreateCustomer('12345678901', new Types.ObjectId().toString(), STAFF_ID),
      ).rejects.toThrow(/does not exist/);

      expect(await customerModel.countDocuments()).toBe(0);
      expect(await kycRecordModel.countDocuments()).toBe(0);
    });

    it('rejects a BVN already registered to another customer — before even calling the provider', async () => {
      const bvn = '12345678999';
      await runConsentFlow(bvn);
      expect(await customerModel.countDocuments()).toBe(1);

      await expect(service.verifyBvnAndCreateCustomer(bvn, branchId, STAFF_ID)).rejects.toThrow(
        /already registered/,
      );

      // No second Customer/KycRecord created for the duplicate attempt.
      expect(await customerModel.countDocuments()).toBe(1);
      expect(await kycRecordModel.countDocuments()).toBe(1);
    });

    it('rejects a different BVN that resolves to a phone number already registered to another customer', async () => {
      // MockBvnVerificationAdapter resolves phoneNumber deterministically as
      // `080${bvn.slice(-8)}` — these two distinct BVNs share the same last
      // 8 digits, so they resolve to the same phone number.
      await runConsentFlow('11145678901');
      expect(await customerModel.countDocuments()).toBe(1);

      await expect(service.verifyBvnAndCreateCustomer('22245678901', branchId, STAFF_ID)).rejects.toThrow(
        /phone number .* already exists/,
      );

      // No second Customer/KycRecord created for the duplicate attempt.
      expect(await customerModel.countDocuments()).toBe(1);
      expect(await kycRecordModel.countDocuments()).toBe(1);
    });
  });

  describe('previewBvn / confirmCustomerFromPreview — the real onboarding UI\'s two-step flow', () => {
    it('previewBvn creates no Customer/KycRecord, only a preview', async () => {
      const preview = await service.previewBvn('55545678901', branchId, STAFF_ID);

      expect(preview.previewId).toBeTruthy();
      expect(preview.resolved.firstName).toBeTruthy();
      expect(preview.mismatchFlags).toEqual([]);
      expect(await customerModel.countDocuments()).toBe(0);
      expect(await kycRecordModel.countDocuments()).toBe(0);

      const stored = await bvnVerificationPreviewModel.findById(preview.previewId).exec();
      expect(stored).not.toBeNull();
      expect(stored?.consumedAt).toBeNull();
    });

    it('confirmCustomerFromPreview (no mismatch) creates the Customer + KycRecord and consumes the preview', async () => {
      const preview = await service.previewBvn('66645678901', branchId, STAFF_ID);

      const result = await service.confirmCustomerFromPreview(preview.previewId, STAFF_ID, {
        useSubmittedValues: false,
      });

      // Created as DRAFT, not PENDING_APPROVAL — the marketer still has to
      // finish onboarding details/biometric capture and call
      // submitForApproval before this is visible to any reviewer. See
      // CustomerStatus.DRAFT's own doc comment.
      expect(result.customer.status).toBe(CustomerStatus.DRAFT);
      expect(result.customer.firstName).toBe(preview.resolved.firstName);
      expect(result.customer.phoneNumber).toBe(preview.resolved.phoneNumber);
      expect(await customerModel.countDocuments()).toBe(1);

      const kyc = await kycRecordModel.findOne({ customerId: result.customer._id }).exec();
      expect(kyc).not.toBeNull();
      expect(kyc?.bvnVerifiedAt).not.toBeNull();

      const stored = await bvnVerificationPreviewModel.findById(preview.previewId).exec();
      expect(stored?.consumedAt).not.toBeNull();
    });

    it('confirming an already-consumed preview a second time is rejected, without creating a second customer', async () => {
      const preview = await service.previewBvn('77745678901', branchId, STAFF_ID);
      await service.confirmCustomerFromPreview(preview.previewId, STAFF_ID, { useSubmittedValues: false });

      await expect(
        service.confirmCustomerFromPreview(preview.previewId, STAFF_ID, { useSubmittedValues: false }),
      ).rejects.toThrow(/already been used/);
      expect(await customerModel.countDocuments()).toBe(1);
    });

    it('rejects confirmation from anyone other than the staff member who ran previewBvn', async () => {
      const preview = await service.previewBvn('88845678901', branchId, STAFF_ID);

      await expect(
        service.confirmCustomerFromPreview(preview.previewId, new Types.ObjectId().toString(), {
          useSubmittedValues: false,
        }),
      ).rejects.toThrow(/Only the staff member who verified this BVN/);
      expect(await customerModel.countDocuments()).toBe(0);
    });

    it('rejects an unknown previewId', async () => {
      await expect(
        service.confirmCustomerFromPreview(new Types.ObjectId().toString(), STAFF_ID, {
          useSubmittedValues: false,
        }),
      ).rejects.toThrow(/not found/);
    });

    it('rejects an expired preview, even though it was never explicitly consumed', async () => {
      const preview = await service.previewBvn('99945678901', branchId, STAFF_ID);
      await bvnVerificationPreviewModel
        .updateOne({ _id: preview.previewId }, { $set: { expiresAt: new Date(Date.now() - 1000) } })
        .exec();

      await expect(
        service.confirmCustomerFromPreview(preview.previewId, STAFF_ID, { useSubmittedValues: false }),
      ).rejects.toThrow(/expired/);
      expect(await customerModel.countDocuments()).toBe(0);
    });

    it('with a submitted-value mismatch: useSubmittedValues requires a reason and overwrites only the flagged fields, resolved from the moment the record exists', async () => {
      const preview = await service.previewBvn('11245678901', branchId, STAFF_ID, {
        fullName: 'Someone Else Entirely',
      });
      expect(preview.mismatchFlags).toHaveLength(1);
      expect(preview.mismatchFlags[0]?.field).toBe('fullName');

      await expect(
        service.confirmCustomerFromPreview(preview.previewId, STAFF_ID, {
          useSubmittedValues: true,
          fullName: 'Someone Else Entirely',
        }),
      ).rejects.toThrow(/reason is required/);

      const result = await service.confirmCustomerFromPreview(preview.previewId, STAFF_ID, {
        useSubmittedValues: true,
        fullName: 'Someone Else Entirely',
        reason: 'Customer confirmed their legal name in person',
      });

      expect(result.customer.firstName).toBe('Someone');
      expect(result.customer.lastName).toBe('Else Entirely');
      // Not flagged, so the provider's phone is kept even though submitted values were chosen for the name.
      expect(result.customer.phoneNumber).toBe(preview.resolved.phoneNumber);
      expect(result.mismatchFlags[0]).toMatchObject({
        resolution: 'USED_SUBMITTED_VALUE',
        reason: 'Customer confirmed their legal name in person',
      });
      expect(result.mismatchFlags[0]?.resolvedAt).not.toBeNull();
    });

    it('re-checks phone-number availability at confirm time, even though the preview itself was clean when created', async () => {
      const preview = await service.previewBvn('11145678901', branchId, STAFF_ID);

      // A different BVN sharing the same last-8-digits (so it resolves via
      // the mock to the same phone) gets fully confirmed in between —
      // exactly the "another verification completed in the meantime" race
      // the re-check exists for.
      await runConsentFlow('22245678901');

      await expect(
        service.confirmCustomerFromPreview(preview.previewId, STAFF_ID, { useSubmittedValues: false }),
      ).rejects.toThrow(/phone number .* already exists/);
      expect(await customerModel.countDocuments()).toBe(1); // only the one from runConsentFlow
    });
  });

  describe('BVN submission mismatch validation', () => {
    // MockBvnVerificationAdapter.buildDetails is deterministic: firstName
    // 'Mock', lastName 'Customer', phoneNumber `080${bvn.slice(-8)}`.
    function resolvedPhoneFor(bvn: string): string {
      return `080${bvn.slice(-8).padStart(8, '0')}`;
    }

    it('records no mismatchFlags and stays VERIFIED once biometric is captured, when nothing was submitted to compare', async () => {
      const bvn = '12345678901';
      const { customer, mismatchFlags } = await service.verifyBvnAndCreateCustomer(bvn, branchId, STAFF_ID);
      expect(mismatchFlags).toEqual([]);

      await service.captureBiometric(customer._id.toString(), Buffer.from('img'), 'image/jpeg', STAFF_ID);
      const updated = await customerModel.findById(customer._id).exec();
      expect(updated?.kycStatus).toBe(KycStatus.VERIFIED);
    });

    it('records no mismatchFlags when the submitted fullName/phoneNumber match the provider exactly', async () => {
      const bvn = '12345678902';
      const { mismatchFlags } = await service.verifyBvnAndCreateCustomer(bvn, branchId, STAFF_ID, {
        fullName: 'Mock Customer',
        phoneNumber: resolvedPhoneFor(bvn),
      });
      expect(mismatchFlags).toEqual([]);
    });

    it('flags a mismatched fullName and/or phoneNumber, and recomputeKycStatus reports MISMATCH_FLAGGED instead of VERIFIED once biometric is captured', async () => {
      const bvn = '12345678903';
      const { customer, mismatchFlags } = await service.verifyBvnAndCreateCustomer(bvn, branchId, STAFF_ID, {
        fullName: 'Someone Else Entirely',
        phoneNumber: '08099999999',
      });

      expect(mismatchFlags).toHaveLength(2);
      expect(mismatchFlags.map((f) => f.field).sort()).toEqual(['fullName', 'phoneNumber']);
      expect(mismatchFlags.find((f) => f.field === 'fullName')).toMatchObject({
        submitted: 'Someone Else Entirely',
        providerValue: 'Mock Customer',
      });

      await service.captureBiometric(customer._id.toString(), Buffer.from('img'), 'image/jpeg', STAFF_ID);
      const updated = await customerModel.findById(customer._id).exec();
      expect(updated?.kycStatus).toBe(KycStatus.MISMATCH_FLAGGED);

      // isLoanEligible only ever accepts VERIFIED.
      expect(await service.isLoanEligible(customer._id.toString())).toBe(false);
    });

    it('getMismatchFlags returns the recorded flags and is audit-logged', async () => {
      const bvn = '12345678904';
      const { customer } = await service.verifyBvnAndCreateCustomer(bvn, branchId, STAFF_ID, {
        fullName: 'Wrong Name',
        phoneNumber: resolvedPhoneFor(bvn),
      });

      const flags = await service.getMismatchFlags(customer._id.toString(), APPROVER_ID);
      expect(flags).toHaveLength(1);
      expect(flags[0]).toMatchObject({ field: 'fullName' });

      const entries = await auditService.findByEntity('CUSTOMER', customer._id.toString());
      expect(entries.some((e) => e.action === 'KYC_DATA_READ')).toBe(true);
    });

    it('phone comparison is lenient about leading-zero/country-code formatting differences', async () => {
      const bvn = '12345678905';
      // e.g. resolved "08012345678" vs submitted "23412345678" — same number,
      // country-code form instead of the local leading 0.
      const countryCodeForm = `234${resolvedPhoneFor(bvn).slice(1)}`;
      const { mismatchFlags } = await service.verifyBvnAndCreateCustomer(bvn, branchId, STAFF_ID, {
        fullName: 'Mock Customer',
        phoneNumber: countryCodeForm,
      });
      expect(mismatchFlags).toEqual([]);
    });

    describe('resolveIdentityMismatch', () => {
      it('rejects a non-creator', async () => {
        const bvn = '12345678906';
        const { customer } = await service.verifyBvnAndCreateCustomer(bvn, branchId, STAFF_ID, {
          fullName: 'Someone Else',
        });

        await expect(
          service.resolveIdentityMismatch(customer._id.toString(), new Types.ObjectId().toString(), {
            useSubmittedValues: false,
          }),
        ).rejects.toThrow();
      });

      it('rejects when there is nothing unresolved to resolve', async () => {
        const customer = await runConsentFlow('12345678907'); // no mismatch at all

        await expect(
          service.resolveIdentityMismatch(customer._id.toString(), STAFF_ID, { useSubmittedValues: false }),
        ).rejects.toThrow(/no unresolved identity mismatch/);
      });

      it('KEPT_PROVIDER_VALUE: leaves the Customer untouched, requires no reason, and clears kycStatus back to VERIFIED', async () => {
        const bvn = '12345678908';
        const { customer } = await service.verifyBvnAndCreateCustomer(bvn, branchId, STAFF_ID, {
          fullName: 'Someone Else Entirely',
        });
        await service.captureBiometric(customer._id.toString(), Buffer.from('img'), 'image/jpeg', STAFF_ID);
        const flaggedStatus = await customerModel.findById(customer._id).exec();
        expect(flaggedStatus?.kycStatus).toBe(KycStatus.MISMATCH_FLAGGED);

        const result = await service.resolveIdentityMismatch(customer._id.toString(), STAFF_ID, {
          useSubmittedValues: false,
        });

        expect(result.customer.firstName).toBe('Mock');
        expect(result.customer.lastName).toBe('Customer');
        expect(result.mismatchFlags[0]).toMatchObject({ resolution: 'KEPT_PROVIDER_VALUE', reason: null });
        expect(result.mismatchFlags[0]?.resolvedAt).not.toBeNull();

        const resolvedStatus = await customerModel.findById(customer._id).exec();
        expect(resolvedStatus?.kycStatus).toBe(KycStatus.VERIFIED);
      });

      it('USED_SUBMITTED_VALUE: requires a reason, overwrites firstName/lastName from the submitted fullName, and clears kycStatus back to VERIFIED', async () => {
        const bvn = '12345678909';
        const { customer } = await service.verifyBvnAndCreateCustomer(bvn, branchId, STAFF_ID, {
          fullName: 'Correct Person',
        });
        await service.captureBiometric(customer._id.toString(), Buffer.from('img'), 'image/jpeg', STAFF_ID);

        await expect(
          service.resolveIdentityMismatch(customer._id.toString(), STAFF_ID, {
            useSubmittedValues: true,
            fullName: 'Correct Person',
          }),
        ).rejects.toThrow(/reason is required/);

        const result = await service.resolveIdentityMismatch(customer._id.toString(), STAFF_ID, {
          useSubmittedValues: true,
          fullName: 'Correct Person',
          reason: 'Marketer confirmed with customer in person',
        });

        expect(result.customer.firstName).toBe('Correct');
        expect(result.customer.lastName).toBe('Person');
        expect(result.mismatchFlags[0]).toMatchObject({
          resolution: 'USED_SUBMITTED_VALUE',
          reason: 'Marketer confirmed with customer in person',
        });

        const resolvedStatus = await customerModel.findById(customer._id).exec();
        expect(resolvedStatus?.kycStatus).toBe(KycStatus.VERIFIED);
        expect(resolvedStatus?.firstName).toBe('Correct');
      });

      it('USED_SUBMITTED_VALUE for a phoneNumber flag rejects a phone already registered to another customer', async () => {
        const otherCustomer = await runConsentFlow('33345678911');

        const bvn = '44445678912';
        const { customer } = await service.verifyBvnAndCreateCustomer(bvn, branchId, STAFF_ID, {
          fullName: 'Mock Customer',
          phoneNumber: '08011112222',
        });

        await expect(
          service.resolveIdentityMismatch(customer._id.toString(), STAFF_ID, {
            useSubmittedValues: true,
            phoneNumber: otherCustomer.phoneNumber,
            reason: 'Trying to reuse another customer\'s number',
          }),
        ).rejects.toThrow(/phone number .* already exists/);

        // The customer's own phone number is untouched by the rejected attempt.
        const unchanged = await customerModel.findById(customer._id).exec();
        expect(unchanged?.phoneNumber).not.toBe(otherCustomer.phoneNumber);
      });

      it('is a no-op the second time — throws once every flag is already resolved', async () => {
        const bvn = '12345678910';
        const { customer } = await service.verifyBvnAndCreateCustomer(bvn, branchId, STAFF_ID, {
          fullName: 'Someone Else',
        });
        await service.resolveIdentityMismatch(customer._id.toString(), STAFF_ID, { useSubmittedValues: false });

        await expect(
          service.resolveIdentityMismatch(customer._id.toString(), STAFF_ID, { useSubmittedValues: false }),
        ).rejects.toThrow(/no unresolved identity mismatch/);
      });
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
      // Two-step chain (review, then approve) — see PHASE_6_NOTES.md for the
      // correction from Phase 5's original single-step reading.
      expect(request.status).toBe(WorkflowStatus.PENDING_REVIEW);

      const stillPending = await customerModel.findById(customer._id).exec();
      expect(stillPending?.status).toBe(CustomerStatus.PENDING_APPROVAL);

      const reviewed = await workflowEngineService.act({
        workflowRequestId: request._id.toString(),
        actor: REVIEW_CUSTOMER_ACTOR,
        action: WorkflowStepAction.APPROVED,
      });
      expect(reviewed.status).toBe(WorkflowStatus.PENDING_APPROVAL);

      const stillPendingAfterReview = await customerModel.findById(customer._id).exec();
      expect(stillPendingAfterReview?.status).toBe(CustomerStatus.PENDING_APPROVAL);

      await workflowEngineService.act({
        workflowRequestId: request._id.toString(),
        actor: APPROVE_CUSTOMER_ACTOR,
        action: WorkflowStepAction.APPROVED,
      });

      const activated = await customerModel.findById(customer._id).exec();
      expect(activated?.status).toBe(CustomerStatus.ACTIVE);
    });

    it('rejection at the review step leaves the customer in the terminal REJECTED status', async () => {
      const customer = await readyCustomer();
      const request = await service.submitForApproval(customer._id.toString(), STAFF_ID);

      await workflowEngineService.act({
        workflowRequestId: request._id.toString(),
        actor: REVIEW_CUSTOMER_ACTOR,
        action: WorkflowStepAction.REJECTED,
        comment: 'duplicate customer',
      });

      const rejected = await customerModel.findById(customer._id).exec();
      expect(rejected?.status).toBe(CustomerStatus.REJECTED);
    });

    it('rejection at the approval step (after a passing review) also lands on REJECTED', async () => {
      const customer = await readyCustomer();
      const request = await service.submitForApproval(customer._id.toString(), STAFF_ID);

      await workflowEngineService.act({
        workflowRequestId: request._id.toString(),
        actor: REVIEW_CUSTOMER_ACTOR,
        action: WorkflowStepAction.APPROVED,
      });
      await workflowEngineService.act({
        workflowRequestId: request._id.toString(),
        actor: APPROVE_CUSTOMER_ACTOR,
        action: WorkflowStepAction.REJECTED,
        comment: 'BVN details look mismatched',
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

  describe('resubmitForApproval', () => {
    async function readyCustomer(): Promise<CustomerDocument> {
      const customer = await runConsentFlow();
      await service.captureBiometric(customer._id.toString(), Buffer.from('fake-image'), 'image/jpeg', STAFF_ID);
      return customer;
    }

    it('rejects resubmission unless the customer is currently REJECTED', async () => {
      const customer = await readyCustomer();
      await expect(service.resubmitForApproval(customer._id.toString(), STAFF_ID)).rejects.toThrow(
        /not in a rejected state/,
      );
    });

    it('a REJECTED customer can be edited (previously blocked) and resubmitted, starting a fresh review cycle', async () => {
      const customer = await readyCustomer();
      const request = await service.submitForApproval(customer._id.toString(), STAFF_ID);
      await workflowEngineService.act({
        workflowRequestId: request._id.toString(),
        actor: REVIEW_CUSTOMER_ACTOR,
        action: WorkflowStepAction.REJECTED,
        comment: 'phone number looks wrong',
      });
      expect((await customerModel.findById(customer._id).exec())?.status).toBe(CustomerStatus.REJECTED);

      // Editing while REJECTED used to throw — now allowed, the whole point
      // of the resubmission flow.
      const edited = await service.updateOnboardingDetails(
        customer._id.toString(),
        { address: 'Corrected address' },
        STAFF_ID,
      );
      expect(edited.address).toBe('Corrected address');

      const resubmitted = await service.resubmitForApproval(customer._id.toString(), STAFF_ID);
      expect(resubmitted.status).toBe(WorkflowStatus.PENDING_REVIEW);
      expect(resubmitted.currentStepIndex).toBe(0);

      // The domain entity flips back to PENDING_APPROVAL once the engine
      // confirms the resubmission (handleWorkflowResubmitted).
      const backToPending = await customerModel.findById(customer._id).exec();
      expect(backToPending?.status).toBe(CustomerStatus.PENDING_APPROVAL);

      // The fresh cycle runs through review + approval like a normal submission.
      await workflowEngineService.act({
        workflowRequestId: resubmitted._id.toString(),
        actor: REVIEW_CUSTOMER_ACTOR,
        action: WorkflowStepAction.APPROVED,
      });
      await workflowEngineService.act({
        workflowRequestId: resubmitted._id.toString(),
        actor: APPROVE_CUSTOMER_ACTOR,
        action: WorkflowStepAction.APPROVED,
      });
      expect((await customerModel.findById(customer._id).exec())?.status).toBe(CustomerStatus.ACTIVE);
    });

    it('rejects a non-creator', async () => {
      const customer = await readyCustomer();
      const request = await service.submitForApproval(customer._id.toString(), STAFF_ID);
      await workflowEngineService.act({
        workflowRequestId: request._id.toString(),
        actor: REVIEW_CUSTOMER_ACTOR,
        action: WorkflowStepAction.REJECTED,
        comment: 'nope',
      });

      await expect(
        service.resubmitForApproval(customer._id.toString(), new Types.ObjectId().toString()),
      ).rejects.toThrow();
    });
  });

  describe("editPrivilege — locking an ACTIVE customer's details", () => {
    async function activeCustomer(): Promise<CustomerDocument> {
      const customer = await runConsentFlow();
      await service.captureBiometric(customer._id.toString(), Buffer.from('fake-image'), 'image/jpeg', STAFF_ID);
      const request = await service.submitForApproval(customer._id.toString(), STAFF_ID);
      await workflowEngineService.act({
        workflowRequestId: request._id.toString(),
        actor: REVIEW_CUSTOMER_ACTOR,
        action: WorkflowStepAction.APPROVED,
      });
      await workflowEngineService.act({
        workflowRequestId: request._id.toString(),
        actor: APPROVE_CUSTOMER_ACTOR,
        action: WorkflowStepAction.APPROVED,
      });
      const activated = await customerModel.findById(customer._id).exec();
      return activated!;
    }

    it('updateOnboardingDetails refuses an ACTIVE customer with no granted privilege', async () => {
      const customer = await activeCustomer();
      await expect(
        service.updateOnboardingDetails(customer._id.toString(), { address: 'New address' }, STAFF_ID),
      ).rejects.toThrow(/request edit privilege/);
    });

    it('recordNin refuses an ACTIVE customer with no granted privilege', async () => {
      const customer = await activeCustomer();
      await expect(
        service.recordNin(customer._id.toString(), '98765432109', STAFF_ID),
      ).rejects.toThrow(/request edit privilege/);
    });

    it('full request → grant → edit cycle: the grant is consumed after one use, requiring a fresh request for the next edit', async () => {
      const customer = await activeCustomer();

      const requested = await service.requestEditPrivilege(
        customer._id.toString(),
        'Customer moved house',
        Buffer.from('fake-signature'),
        'image/png',
        STAFF_ID,
      );
      expect(requested.editPrivilege.status).toBe(EditPrivilegeStatus.PENDING);
      expect(requested.editPrivilege.signatureImageKey).toBeTruthy();

      const granted = await service.decideEditPrivilege(
        customer._id.toString(),
        true,
        'Looks legitimate',
        APPROVER_ID,
      );
      expect(granted.editPrivilege.status).toBe(EditPrivilegeStatus.GRANTED);
      expect(granted.editPrivilege.decidedBy?.toString()).toBe(APPROVER_ID);

      const edited = await service.updateOnboardingDetails(
        customer._id.toString(),
        { address: 'New address' },
        STAFF_ID,
      );
      expect(edited.address).toBe('New address');
      // Consumed — the very next edit attempt is blocked again.
      expect(edited.editPrivilege.status).toBe(EditPrivilegeStatus.NONE);
      await expect(
        service.updateOnboardingDetails(customer._id.toString(), { address: 'Yet another address' }, STAFF_ID),
      ).rejects.toThrow(/request edit privilege/);
    });

    it('a REJECTED decision leaves the customer still locked', async () => {
      const customer = await activeCustomer();
      await service.requestEditPrivilege(
        customer._id.toString(),
        'Reason',
        Buffer.from('sig'),
        'image/png',
        STAFF_ID,
      );
      const decided = await service.decideEditPrivilege(customer._id.toString(), false, 'Not convincing', APPROVER_ID);
      expect(decided.editPrivilege.status).toBe(EditPrivilegeStatus.REJECTED);

      await expect(
        service.updateOnboardingDetails(customer._id.toString(), { address: 'New address' }, STAFF_ID),
      ).rejects.toThrow(/request edit privilege/);
    });

    it('rejects a second request while one is already pending', async () => {
      const customer = await activeCustomer();
      await service.requestEditPrivilege(customer._id.toString(), 'First', Buffer.from('sig'), 'image/png', STAFF_ID);
      await expect(
        service.requestEditPrivilege(customer._id.toString(), 'Second', Buffer.from('sig'), 'image/png', STAFF_ID),
      ).rejects.toThrow(/already pending/);
    });

    it('rejects a non-creator requesting an edit privilege', async () => {
      const customer = await activeCustomer();
      await expect(
        service.requestEditPrivilege(
          customer._id.toString(),
          'Reason',
          Buffer.from('sig'),
          'image/png',
          new Types.ObjectId().toString(),
        ),
      ).rejects.toThrow();
    });

    it('rejects requesting an edit privilege for a still-PENDING_APPROVAL customer — already directly editable', async () => {
      const customer = await runConsentFlow();
      await expect(
        service.requestEditPrivilege(customer._id.toString(), 'Reason', Buffer.from('sig'), 'image/png', STAFF_ID),
      ).rejects.toThrow(/already editable/);
    });

    it('decideEditPrivilege rejects when there is nothing pending', async () => {
      const customer = await activeCustomer();
      await expect(
        service.decideEditPrivilege(customer._id.toString(), true, undefined, APPROVER_ID),
      ).rejects.toThrow(/no pending edit privilege/);
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

  describe('reviewBvnComparison', () => {
    it("returns the provider's fresh details alongside what's on the Customer record, and audit-logs the read", async () => {
      const customer = await runConsentFlow('12345678911');

      const result = await service.reviewBvnComparison(customer._id.toString(), APPROVER_ID);
      expect(result.onRecord).toEqual({
        firstName: customer.firstName,
        lastName: customer.lastName,
        phoneNumber: customer.phoneNumber,
      });
      expect(result.provider.bvn).toBe('12345678911');

      const entries = await auditService.findByEntity('CUSTOMER', customer._id.toString());
      expect(entries.some((e) => e.action === 'KYC_DATA_READ')).toBe(true);
    });
  });

  describe('getAuditTrail', () => {
    it("returns every recorded action for a customer the viewer is entitled to see", async () => {
      const customer = await runConsentFlow('12345678912');
      await service.captureBiometric(customer._id.toString(), Buffer.from('img'), 'image/jpeg', STAFF_ID);

      const trail = await service.getAuditTrail(customer._id.toString(), {
        staffId: STAFF_ID,
        role: StaffRole.MARKETER,
      });
      expect(trail.some((e) => e.action === 'CUSTOMER_CREATED_VIA_BVN_VERIFICATION')).toBe(true);
      expect(trail.some((e) => e.action === 'CUSTOMER_BIOMETRIC_CAPTURED')).toBe(true);
    });

    it('rejects a viewer with no permission to see this customer', async () => {
      const customer = await runConsentFlow('12345678913');

      await expect(
        service.getAuditTrail(customer._id.toString(), {
          staffId: new Types.ObjectId().toString(),
          role: StaffRole.MARKETER,
        }),
      ).rejects.toThrow();
    });
  });

  describe('resolveBranchNames', () => {
    it('resolves id -> name for a batch of branch ids, and skips any id with no matching Branch', async () => {
      const branchModel = moduleRef.get<Model<BranchDocument>>(getModelToken(Branch.name));
      const otherBranch = await branchModel.create({ name: 'Second Branch', code: `BR2${Date.now()}`, active: true });

      const map = await service.resolveBranchNames([branchId, otherBranch._id.toString(), new Types.ObjectId().toString()]);

      expect(map.size).toBe(2);
      expect(map.get(branchId)).toBe('Main');
      expect(map.get(otherBranch._id.toString())).toBe('Second Branch');
    });

    it('returns an empty map for an empty input', async () => {
      expect((await service.resolveBranchNames([])).size).toBe(0);
    });
  });

  describe('resolveGroupNames', () => {
    it("resolves a customer's current (leftAt: null) group membership, and omits a customer with no active membership", async () => {
      const customer = await runConsentFlow('12345678920');
      const groupModel = moduleRef.get<Model<GroupDocument>>(getModelToken(Group.name));
      const groupMembershipModel = moduleRef.get<Model<GroupMembershipDocument>>(getModelToken(GroupMembership.name));

      const group = await groupModel.create({
        name: 'Iya Oloja Market Women',
        branchId,
        status: 'ACTIVE',
        createdBy: STAFF_ID,
      });
      await groupMembershipModel.create({
        groupId: group._id,
        customerId: customer._id,
        role: 'MEMBER',
        joinedAt: new Date(),
        addedBy: STAFF_ID,
      });

      const otherCustomer = await runConsentFlow('12345678921');

      const map = await service.resolveGroupNames([customer._id.toString(), otherCustomer._id.toString()]);

      expect(map.size).toBe(1);
      expect(map.get(customer._id.toString())).toBe('Iya Oloja Market Women');
      expect(map.has(otherCustomer._id.toString())).toBe(false);
    });

    it('omits a membership the customer has since left (leftAt set)', async () => {
      const customer = await runConsentFlow('12345678922');
      const groupModel = moduleRef.get<Model<GroupDocument>>(getModelToken(Group.name));
      const groupMembershipModel = moduleRef.get<Model<GroupMembershipDocument>>(getModelToken(GroupMembership.name));

      const group = await groupModel.create({
        name: 'Departed Group',
        branchId,
        status: 'ACTIVE',
        createdBy: STAFF_ID,
      });
      await groupMembershipModel.create({
        groupId: group._id,
        customerId: customer._id,
        role: 'MEMBER',
        joinedAt: new Date(),
        leftAt: new Date(),
        addedBy: STAFF_ID,
      });

      const map = await service.resolveGroupNames([customer._id.toString()]);
      expect(map.has(customer._id.toString())).toBe(false);
    });
  });

  describe('getKycCaptureStatus', () => {
    it('reports every flag false for a fresh customer with nothing captured yet', async () => {
      const customer = await runConsentFlow('12345678914');

      const status = await service.getKycCaptureStatus(customer._id.toString(), {
        staffId: STAFF_ID,
        role: StaffRole.MARKETER,
      });

      expect(status).toEqual({
        biometricCaptured: false,
        idDocumentCaptured: false,
        idDocumentType: null,
        ninRecorded: false,
        ninVerified: false,
        bvnVerifiedAt: expect.any(Date),
      });
    });

    it('flips to true once biometric/ID document/NIN are captured — never exposes the actual value', async () => {
      const customer = await runConsentFlow('12345678915');
      await service.captureBiometric(customer._id.toString(), Buffer.from('img'), 'image/jpeg', STAFF_ID);
      await service.captureIdDocument(customer._id.toString(), Buffer.from('doc'), 'image/jpeg', STAFF_ID, IdDocumentType.VOTERS_CARD);
      await service.recordNin(customer._id.toString(), '123456', STAFF_ID);

      const status = await service.getKycCaptureStatus(customer._id.toString(), {
        staffId: STAFF_ID,
        role: StaffRole.MARKETER,
      });

      expect(status.biometricCaptured).toBe(true);
      expect(status.idDocumentCaptured).toBe(true);
      expect(status.idDocumentType).toBe(IdDocumentType.VOTERS_CARD);
      expect(status.ninRecorded).toBe(true);
      expect(status.ninVerified).toBe(false);
      expect(status).not.toHaveProperty('nin');
      expect(status).not.toHaveProperty('biometricImageKey');
    });

    it('rejects a viewer with no permission to see this customer', async () => {
      const customer = await runConsentFlow('12345678916');

      await expect(
        service.getKycCaptureStatus(customer._id.toString(), {
          staffId: new Types.ObjectId().toString(),
          role: StaffRole.MARKETER,
        }),
      ).rejects.toThrow();
    });
  });

  describe('recordNin — no fixed length', () => {
    it('accepts a NIN of any digit length, not just 11', async () => {
      const customer = await runConsentFlow('12345678917');
      await expect(service.recordNin(customer._id.toString(), '123456', STAFF_ID)).resolves.toBeDefined();

      const status = await service.getKycCaptureStatus(customer._id.toString(), {
        staffId: STAFF_ID,
        role: StaffRole.MARKETER,
      });
      expect(status.ninRecorded).toBe(true);
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

    it('getIdDocumentSignedUrl produces a KYC_DATA_READ audit entry', async () => {
      const customer = await runConsentFlow();
      await service.captureIdDocument(
        customer._id.toString(),
        Buffer.from('id-doc'),
        'image/jpeg',
        STAFF_ID,
      );

      const url = await service.getIdDocumentSignedUrl(customer._id.toString(), APPROVER_ID);
      expect(url).toBeTruthy();

      const entries = await auditService.findByEntity('CUSTOMER', customer._id.toString());
      expect(entries.some((e) => e.action === 'KYC_DATA_READ')).toBe(true);
    });

    it('the BVN provider call produces a BvnCallLog entry', async () => {
      const bvnCallLogModel = moduleRef.get<Model<Record<string, unknown>>>(
        getModelToken(BvnCallLog.name),
      );
      await runConsentFlow();

      const steps = (await bvnCallLogModel.find().exec()).map(
        (l) => (l as unknown as { step: string }).step,
      );
      expect(steps).toContain('DIRECT_VERIFY');
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

  describe('creator-only editing', () => {
    const OTHER_STAFF_ID = new Types.ObjectId().toString();

    it('updateOnboardingDetails rejects a non-creator, even one with the initiate capability', async () => {
      const customer = await runConsentFlow();

      await expect(
        service.updateOnboardingDetails(customer._id.toString(), { address: 'New address' }, OTHER_STAFF_ID),
      ).rejects.toThrow();

      // Unaffected — the rejected call never touched it.
      const unchanged = await customerModel.findById(customer._id).exec();
      expect(unchanged?.address).not.toBe('New address');
    });

    it('updateOnboardingDetails succeeds for the actual creator', async () => {
      const customer = await runConsentFlow();

      const updated = await service.updateOnboardingDetails(
        customer._id.toString(),
        { address: 'New address' },
        STAFF_ID,
      );

      expect(updated.address).toBe('New address');
    });

    it('updateOnboardingDetails persists nextOfKin/guarantors/reference and replaces the whole guarantors array on a second call', async () => {
      const customer = await runConsentFlow();

      const firstUpdate = await service.updateOnboardingDetails(
        customer._id.toString(),
        {
          nextOfKin: { fullName: 'Kin One', phoneNumber: '08011111111', relationship: 'Sibling' },
          guarantors: [
            { fullName: 'Guarantor One', phoneNumber: '08022222222', occupation: 'Trader' },
            { fullName: 'Guarantor Two', phoneNumber: '08033333333' },
          ],
          reference: { fullName: 'Ref One', phoneNumber: '08044444444', yearsKnown: '5' },
        },
        STAFF_ID,
      );

      expect(firstUpdate.nextOfKin).toMatchObject({ fullName: 'Kin One', phoneNumber: '08011111111', relationship: 'Sibling' });
      expect(firstUpdate.guarantors).toHaveLength(2);
      expect(firstUpdate.guarantors[0]).toMatchObject({ fullName: 'Guarantor One', occupation: 'Trader' });
      expect(firstUpdate.reference).toMatchObject({ fullName: 'Ref One', yearsKnown: '5' });

      // A second call with a shorter guarantors array replaces, not merges.
      const secondUpdate = await service.updateOnboardingDetails(
        customer._id.toString(),
        { guarantors: [{ fullName: 'Solo Guarantor', phoneNumber: '08055555555' }] },
        STAFF_ID,
      );

      expect(secondUpdate.guarantors).toHaveLength(1);
      expect(secondUpdate.guarantors[0]).toMatchObject({ fullName: 'Solo Guarantor' });
      // Untouched by the second call.
      expect(secondUpdate.nextOfKin).toMatchObject({ fullName: 'Kin One' });
    });

    it('captureBiometric rejects a non-creator', async () => {
      const customer = await runConsentFlow();

      await expect(
        service.captureBiometric(customer._id.toString(), Buffer.from('img'), 'image/jpeg', OTHER_STAFF_ID),
      ).rejects.toThrow();
    });

    it('captureIdDocument rejects a non-creator, and succeeds for the creator without touching kycStatus', async () => {
      const customer = await runConsentFlow();

      await expect(
        service.captureIdDocument(customer._id.toString(), Buffer.from('id-doc'), 'image/jpeg', OTHER_STAFF_ID),
      ).rejects.toThrow();

      const kyc = await service.captureIdDocument(
        customer._id.toString(),
        Buffer.from('id-doc'),
        'image/jpeg',
        STAFF_ID,
      );
      expect(kyc.idDocumentImageKey).toBeTruthy();

      // Never gates kycStatus — only BVN + biometric do (see recomputeKycStatus).
      const unchanged = await customerModel.findById(customer._id).exec();
      expect(unchanged?.kycStatus).not.toBe(KycStatus.VERIFIED);
    });

    it('recordNin rejects a non-creator', async () => {
      const customer = await runConsentFlow();

      await expect(service.recordNin(customer._id.toString(), '98765432109', OTHER_STAFF_ID)).rejects.toThrow();
    });

    it('submitForApproval rejects a non-creator', async () => {
      const customer = await runConsentFlow();
      await service.captureBiometric(customer._id.toString(), Buffer.from('img'), 'image/jpeg', STAFF_ID);

      await expect(service.submitForApproval(customer._id.toString(), OTHER_STAFF_ID)).rejects.toThrow();
    });
  });

  describe('findAllForActor / findByIdForActor — role-scoped reads', () => {
    const ADMIN_ID = new Types.ObjectId().toString();
    const MANAGER_ID = new Types.ObjectId().toString();
    const MARKETER_ID = new Types.ObjectId().toString();
    const OTHER_MARKETER_ID = new Types.ObjectId().toString();
    let otherBranchId: string;

    beforeEach(async () => {
      const branchModel = moduleRef.get<Model<BranchDocument>>(getModelToken(Branch.name));
      const otherBranch = await branchModel.create({
        name: 'Other Branch',
        code: `BR${Date.now()}${Math.random()}`,
        active: true,
      });
      otherBranchId = otherBranch._id.toString();
    });

    async function createCustomerAs(creatorId: string, targetBranchId: string): Promise<CustomerDocument> {
      const result = await service.verifyBvnAndCreateCustomer(
        `1${Math.floor(Math.random() * 1e10)}`.slice(0, 11),
        targetBranchId,
        creatorId,
      );
      return result.customer;
    }

    it('ADMIN/SUPERADMIN/APPROVER see every customer and may filter by branchId/createdById', async () => {
      const mine = await createCustomerAs(MARKETER_ID, branchId);
      await createCustomerAs(OTHER_MARKETER_ID, otherBranchId);

      const admin = { staffId: ADMIN_ID, role: StaffRole.ADMIN };
      const all = await service.findAllForActor({}, admin);
      expect(all.length).toBe(2);

      const filteredByBranch = await service.findAllForActor({ branchId }, admin);
      expect(filteredByBranch.map((c) => c._id.toString())).toEqual([mine._id.toString()]);

      const filteredByCreator = await service.findAllForActor({ createdById: MARKETER_ID }, admin);
      expect(filteredByCreator.map((c) => c._id.toString())).toEqual([mine._id.toString()]);
    });

    it("MANAGER only sees their own branch's customers, ignoring any branchId/createdById they pass", async () => {
      const inBranch = await createCustomerAs(MARKETER_ID, branchId);
      await createCustomerAs(OTHER_MARKETER_ID, otherBranchId);

      const manager = { staffId: MANAGER_ID, role: StaffRole.MANAGER, branchId };
      const result = await service.findAllForActor({ branchId: otherBranchId }, manager);

      expect(result.map((c) => c._id.toString())).toEqual([inBranch._id.toString()]);
    });

    it('a DRAFT customer (BVN-verified but not yet submitted) is hidden from MANAGER/ADMIN but visible to its own creator', async () => {
      const preview = await service.previewBvn(
        `1${Math.floor(Math.random() * 1e10)}`.slice(0, 11),
        branchId,
        MARKETER_ID,
      );
      const { customer: draft } = await service.confirmCustomerFromPreview(preview.previewId, MARKETER_ID, {
        useSubmittedValues: false,
      });
      expect(draft.status).toBe(CustomerStatus.DRAFT);

      const manager = { staffId: MANAGER_ID, role: StaffRole.MANAGER, branchId };
      expect(await service.findAllForActor({}, manager)).toEqual([]);

      const admin = { staffId: ADMIN_ID, role: StaffRole.ADMIN };
      expect(await service.findAllForActor({}, admin)).toEqual([]);

      const marketer = { staffId: MARKETER_ID, role: StaffRole.MARKETER };
      const ownView = await service.findAllForActor({}, marketer);
      expect(ownView.map((c) => c._id.toString())).toEqual([draft._id.toString()]);

      // Once the marketer actually submits it, it flips to PENDING_APPROVAL
      // and becomes visible to the Manager — no longer a draft.
      await service.captureBiometric(draft._id.toString(), Buffer.from('fake-image'), 'image/jpeg', MARKETER_ID);
      await service.submitForApproval(draft._id.toString(), MARKETER_ID);

      const afterSubmit = await service.findAllForActor({}, manager);
      expect(afterSubmit.map((c) => c._id.toString())).toEqual([draft._id.toString()]);
    });

    it('MARKETER only sees their own records, ignoring any branchId/createdById they pass', async () => {
      const own = await createCustomerAs(MARKETER_ID, branchId);
      await createCustomerAs(OTHER_MARKETER_ID, branchId);

      const marketer = { staffId: MARKETER_ID, role: StaffRole.MARKETER };
      const result = await service.findAllForActor({ createdById: OTHER_MARKETER_ID }, marketer);

      expect(result.map((c) => c._id.toString())).toEqual([own._id.toString()]);
    });

    it('findByIdForActor rejects a MARKETER viewing a record they did not create', async () => {
      const notMine = await createCustomerAs(OTHER_MARKETER_ID, branchId);

      await expect(
        service.findByIdForActor(notMine._id.toString(), { staffId: MARKETER_ID, role: StaffRole.MARKETER }),
      ).rejects.toThrow();
    });

    it('findByIdForActor rejects a MANAGER viewing a record from a different branch', async () => {
      const elsewhere = await createCustomerAs(MARKETER_ID, otherBranchId);

      await expect(
        service.findByIdForActor(elsewhere._id.toString(), {
          staffId: MANAGER_ID,
          role: StaffRole.MANAGER,
          branchId,
        }),
      ).rejects.toThrow();
    });

    it('findByIdForActor allows the creator to view their own record', async () => {
      const own = await createCustomerAs(MARKETER_ID, branchId);

      const found = await service.findByIdForActor(own._id.toString(), {
        staffId: MARKETER_ID,
        role: StaffRole.MARKETER,
      });
      expect(found._id.toString()).toBe(own._id.toString());
    });
  });

  describe('disable / enable', () => {
    async function activeCustomer(): Promise<CustomerDocument> {
      const customer = await runConsentFlow(`1${Math.floor(Math.random() * 1e10)}`.slice(0, 11));
      await service.captureBiometric(customer._id.toString(), Buffer.from('img'), 'image/jpeg', STAFF_ID);
      const request = await service.submitForApproval(customer._id.toString(), STAFF_ID);
      await workflowEngineService.act({
        workflowRequestId: request._id.toString(),
        actor: REVIEW_CUSTOMER_ACTOR,
        action: WorkflowStepAction.APPROVED,
      });
      await workflowEngineService.act({
        workflowRequestId: request._id.toString(),
        actor: APPROVE_CUSTOMER_ACTOR,
        action: WorkflowStepAction.APPROVED,
      });
      return (await customerModel.findById(customer._id).exec())!;
    }

    it('disables an active customer, recording who and why', async () => {
      const customer = await activeCustomer();
      const disabledBy = new Types.ObjectId().toString();

      const disabled = await service.disable(customer._id.toString(), disabledBy, 'Fraud suspected');

      expect(disabled.status).toBe(CustomerStatus.DISABLED);
      expect(disabled.disabledReason).toBe('Fraud suspected');
      expect(disabled.disabledBy?.toString()).toBe(disabledBy);
      expect(disabled.disabledAt).not.toBeNull();
    });

    it('rejects disabling a customer that is not ACTIVE', async () => {
      const customer = await runConsentFlow(`1${Math.floor(Math.random() * 1e10)}`.slice(0, 11));

      await expect(service.disable(customer._id.toString(), STAFF_ID, 'reason')).rejects.toThrow();
    });

    it('enable reverses disable, clearing the disable fields', async () => {
      const customer = await activeCustomer();
      const actorId = new Types.ObjectId().toString();
      await service.disable(customer._id.toString(), actorId, 'temporary suspension');

      const enabled = await service.enable(customer._id.toString(), actorId);

      expect(enabled.status).toBe(CustomerStatus.ACTIVE);
      expect(enabled.disabledReason).toBeNull();
      expect(enabled.disabledBy).toBeNull();
      expect(enabled.disabledAt).toBeNull();
    });

    it('rejects enabling a customer that is not disabled', async () => {
      const customer = await activeCustomer();

      await expect(service.enable(customer._id.toString(), STAFF_ID)).rejects.toThrow();
    });
  });
});

/**
 * CUSTOMER_ENFORCE_UNIQUE_PHONE=false — a separate module instance, since
 * ConfigModule.forRoot's loaded config is fixed for the lifetime of the
 * module it's registered on (the main describe block above always runs with
 * it true). See env.validation.ts's own doc comment for why this toggle
 * exists at all.
 */
describe('CustomerService — CUSTOMER_ENFORCE_UNIQUE_PHONE=false', () => {
  const mongo = new InMemoryMongo();
  let moduleRef: TestingModule;
  let service: CustomerService;
  let customerModel: Model<CustomerDocument>;
  let branchId: string;
  const STAFF_ID = new Types.ObjectId().toString();

  beforeAll(async () => {
    process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    __resetPiiEncryptionKeyCache();

    await mongo.start();

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ customers: { enforceUniquePhoneNumber: false } })],
        }),
        MongooseModule.forRoot(mongo.getUri()),
        MongooseModule.forFeature([
          { name: Customer.name, schema: CustomerSchema },
          { name: KycRecord.name, schema: KycRecordSchema },
          { name: Branch.name, schema: BranchSchema },
          { name: Staff.name, schema: StaffSchema },
          { name: Group.name, schema: GroupSchema },
          { name: GroupMembership.name, schema: GroupMembershipSchema },
          { name: WorkflowChainConfig.name, schema: WorkflowChainConfigSchema },
          { name: WorkflowRequest.name, schema: WorkflowRequestSchema },
          { name: BvnCallLog.name, schema: BvnCallLogSchema },
          { name: BvnVerificationPreview.name, schema: BvnVerificationPreviewSchema },
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
    customerModel = moduleRef.get(getModelToken(Customer.name));

    await moduleRef.init();
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

  afterAll(async () => {
    await moduleRef.close();
    await mongo.stop();
  });

  it('allows two different customers to share a phone number once the guard is disabled', async () => {
    // Same "different BVNs, same last-8-digits" trick as the enforced-guard
    // test above — MockBvnVerificationAdapter resolves phoneNumber as
    // `080${bvn.slice(-8)}`.
    const first = await service.verifyBvnAndCreateCustomer('11145678901', branchId, STAFF_ID);
    const second = await service.verifyBvnAndCreateCustomer('22245678901', branchId, STAFF_ID);

    expect(first.customer.phoneNumber).toBe(second.customer.phoneNumber);
    expect(await customerModel.countDocuments({ phoneNumber: first.customer.phoneNumber })).toBe(2);
  });
});
