import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { CustomerStatus, KycStatus } from '../../common/enums/customer.enums';
import { WorkflowEntityType } from '../../common/enums/workflow.enums';
import { AuditService } from '../../platform/audit/audit.service';
import { EncryptionService } from '../../platform/encryption/encryption.service';
import { BvnConsentExpiredException } from '../../platform/integrations/bvn/exceptions/bvn-consent-expired.exception';
import {
  BVN_VERIFICATION_ADAPTER,
  BvnDetails,
  BvnVerificationAdapter,
} from '../../platform/integrations/bvn/interfaces/bvn-verification-adapter.interface';
import {
  S3_ADAPTER,
  S3Adapter,
} from '../../platform/integrations/s3/interfaces/s3-adapter.interface';
import { buildKycObjectKey } from '../../platform/integrations/s3/s3-key.util';
import { approveCapability, reviewCapability } from '../../platform/rbac/constants/capabilities';
import {
  WORKFLOW_APPROVED_EVENT,
  WORKFLOW_REJECTED_EVENT,
  WorkflowApprovedEvent,
  WorkflowRejectedEvent,
} from '../../platform/workflow-engine/events/workflow-engine.events';
import { WorkflowEngineService } from '../../platform/workflow-engine/workflow-engine.service';
import { WorkflowRequestDocument } from '../../platform/workflow-engine/schemas/workflow-request.schema';
// Cross-module read only — the raw Branch model, same pattern established in
// Phase 3/4 (see identity/staff.service.ts, branches/branch-manager-assignment.service.ts).
import { Branch, BranchDocument } from '../branches/schemas/branch.schema';
import { VerificationContext } from './enums/verification-context.enum';
import { Customer, CustomerDocument } from './schemas/customer.schema';
import { KycRecord, KycRecordDocument } from './schemas/kyc-record.schema';
import { PendingBvnConsent, PendingBvnConsentDocument } from './schemas/pending-bvn-consent.schema';

const KYC_CHAIN_ACTION = 'CREATE';

export interface StartBvnConsentResult {
  pendingConsentId: string;
  otpSentToPhone: string;
  expiresAt: Date;
}

export interface UpdateOnboardingDetailsInput {
  address?: string;
  email?: string;
  nin?: string;
}

@Injectable()
export class CustomerService implements OnModuleInit {
  constructor(
    @InjectModel(Customer.name) private readonly customerModel: Model<CustomerDocument>,
    @InjectModel(KycRecord.name) private readonly kycRecordModel: Model<KycRecordDocument>,
    @InjectModel(PendingBvnConsent.name)
    private readonly pendingBvnConsentModel: Model<PendingBvnConsentDocument>,
    @InjectModel(Branch.name) private readonly branchModel: Model<BranchDocument>,
    @Inject(BVN_VERIFICATION_ADAPTER) private readonly bvnAdapter: BvnVerificationAdapter,
    @Inject(S3_ADAPTER) private readonly s3Adapter: S3Adapter,
    private readonly encryptionService: EncryptionService,
    private readonly auditService: AuditService,
    private readonly workflowEngineService: WorkflowEngineService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Two steps (review, then approve) — corrected from Phase 5's original
    // single-step reading of "reviewed and approved" once Phase 6 applied the
    // same brief language consistently to Group creation. See PHASE_6_NOTES.md
    // for the correction; the chain-config upsert is idempotent
    // ($setOnInsert), so this change only takes effect for environments that
    // haven't already inserted the old single-step config — see that same
    // note for the migration caveat.
    await this.workflowEngineService.registerChainConfig({
      entityType: WorkflowEntityType.CUSTOMER,
      action: KYC_CHAIN_ACTION,
      restartOnReturn: true,
      steps: [
        { order: 0, requiredCapability: reviewCapability(WorkflowEntityType.CUSTOMER) },
        { order: 1, requiredCapability: approveCapability(WorkflowEntityType.CUSTOMER) },
      ],
    });
  }

  // ---------------------------------------------------------------------------
  // Step 1: BVN consent
  // ---------------------------------------------------------------------------

  async startBvnConsent(
    bvn: string,
    initiatedBy: string,
    branchId: string,
  ): Promise<StartBvnConsentResult> {
    const branchExists = await this.branchModel.exists({ _id: branchId });
    if (!branchExists) {
      throw new BadRequestException(`Branch ${branchId} does not exist`);
    }

    const initiation = await this.bvnAdapter.initiateConsent(bvn, {
      calledBy: initiatedBy,
      entityType: 'CUSTOMER',
    });

    const pending = await this.pendingBvnConsentModel.create({
      bvn: this.encryptionService.encrypt(bvn),
      consentToken: this.encryptionService.encrypt(initiation.consentToken),
      initiatedBy,
      branchId,
      expiresAt: initiation.expiresAt,
    });

    return {
      pendingConsentId: pending._id.toString(),
      otpSentToPhone: initiation.otpSentToPhone,
      expiresAt: initiation.expiresAt,
    };
  }

  async confirmBvnConsent(pendingConsentId: string, otp: string): Promise<CustomerDocument> {
    const pending = await this.pendingBvnConsentModel.findById(pendingConsentId).exec();
    if (!pending) {
      throw new NotFoundException(`PendingBvnConsent ${pendingConsentId} not found`);
    }

    // Our own check first — a PendingBvnConsent must never be usable past its
    // expiresAt, correct OTP or not, and this saves a provider call besides.
    if (pending.expiresAt.getTime() < Date.now()) {
      await this.pendingBvnConsentModel.deleteOne({ _id: pending._id }).exec();
      throw new BvnConsentExpiredException();
    }

    const consentToken = this.encryptionService.decrypt(pending.consentToken);
    const initiatedBy = pending.initiatedBy.toString();

    // BvnOtpInvalidException / BvnConsentExpiredException propagate as-is —
    // no Customer/KycRecord is created on failure, and the PendingBvnConsent
    // record survives an OTP mismatch (not deleted) so the marketer can retry
    // without restarting the whole consent flow.
    const details = await this.bvnAdapter.confirmConsent(consentToken, otp, {
      calledBy: initiatedBy,
      entityType: 'CUSTOMER',
    });

    const now = new Date();
    const customer = await this.customerModel.create({
      firstName: details.firstName,
      lastName: details.lastName,
      phoneNumber: details.phoneNumber,
      branchId: pending.branchId,
      status: CustomerStatus.PENDING_APPROVAL,
      kycStatus: KycStatus.INCOMPLETE,
      createdBy: pending.initiatedBy,
    });

    await this.kycRecordModel.create({
      customerId: customer._id,
      bvn: this.encryptionService.encrypt(details.bvn),
      bvnConsentDetailsEncrypted: this.encryptionService.encrypt(JSON.stringify(details)),
      bvnVerifiedAt: now,
      lastVerifiedForContext: [VerificationContext.KYC_CAPTURE],
    });

    await this.pendingBvnConsentModel.deleteOne({ _id: pending._id }).exec();

    await this.auditService.record({
      actorId: initiatedBy,
      action: 'CUSTOMER_CREATED_VIA_BVN_CONSENT',
      entityType: 'CUSTOMER',
      entityId: customer._id.toString(),
      after: { phoneNumber: details.phoneNumber, branchId: pending.branchId.toString() },
    });

    return customer;
  }

  // ---------------------------------------------------------------------------
  // Steps 3-4: remaining details, biometric
  // ---------------------------------------------------------------------------

  private async findActiveDraft(customerId: string): Promise<CustomerDocument> {
    const customer = await this.customerModel.findById(customerId).exec();
    if (!customer) {
      throw new NotFoundException(`Customer ${customerId} not found`);
    }
    return customer;
  }

  async updateOnboardingDetails(
    customerId: string,
    input: UpdateOnboardingDetailsInput,
    _updatedBy: string,
  ): Promise<CustomerDocument> {
    const customer = await this.findActiveDraft(customerId);
    if (customer.status === CustomerStatus.REJECTED) {
      throw new ConflictException(`Customer ${customerId} has been rejected — cannot edit`);
    }

    if (input.address !== undefined) {
      customer.address = input.address;
    }
    if (input.email !== undefined) {
      customer.email = input.email.toLowerCase();
    }
    await customer.save();

    if (input.nin !== undefined) {
      await this.recordNin(customerId, input.nin, _updatedBy);
    }

    return customer;
  }

  async captureBiometric(
    customerId: string,
    imageBuffer: Buffer,
    contentType: string,
    capturedBy: string,
  ): Promise<KycRecordDocument> {
    const customer = await this.findActiveDraft(customerId);
    if (customer.status !== CustomerStatus.PENDING_APPROVAL) {
      throw new ConflictException(
        `Customer ${customerId} is not in a state that accepts KYC capture`,
      );
    }

    const extension = contentType.split('/')[1] ?? 'jpg';
    const key = buildKycObjectKey(customerId, 'biometric', extension);
    await this.s3Adapter.upload(key, imageBuffer, contentType);

    const kyc = await this.getKycRecordOrThrow(customerId);
    kyc.biometricImageKey = key;
    await kyc.save();

    await this.auditService.record({
      actorId: capturedBy,
      action: 'CUSTOMER_BIOMETRIC_CAPTURED',
      entityType: 'CUSTOMER',
      entityId: customerId,
      metadata: { key },
    });

    await this.recomputeKycStatus(customerId);
    return kyc;
  }

  // ---------------------------------------------------------------------------
  // NIN — optional, manually verified, never gates kycStatus
  // ---------------------------------------------------------------------------

  async recordNin(customerId: string, nin: string, capturedBy: string): Promise<KycRecordDocument> {
    const customer = await this.findActiveDraft(customerId);
    if (customer.status === CustomerStatus.REJECTED) {
      throw new ConflictException(`Customer ${customerId} has been rejected — cannot edit`);
    }

    const kyc = await this.getKycRecordOrThrow(customerId);
    kyc.nin = this.encryptionService.encrypt(nin);
    kyc.ninVerifiedAt = null;
    kyc.ninManuallyVerifiedBy = null;
    kyc.ninVerificationNote = null;
    await kyc.save();

    await this.auditService.record({
      actorId: capturedBy,
      action: 'CUSTOMER_NIN_RECORDED',
      entityType: 'CUSTOMER',
      entityId: customerId,
    });

    return kyc;
  }

  /**
   * Human attestation, not an automated check — there's no NIN provider to
   * compare against, so there's no mismatch path here (unlike BVN). Callers
   * (the controller) must gate this behind a capability — reused
   * `workflow:approve:CUSTOMER` rather than introducing a separate
   * `customer:nin_verify`, since both represent the same level of trust
   * ("someone empowered to finalize this customer's KYC standing"). See
   * PHASE_5_NOTES.md.
   */
  async manuallyVerifyNin(
    customerId: string,
    verifiedBy: string,
    note?: string,
  ): Promise<KycRecordDocument> {
    const kyc = await this.getKycRecordOrThrow(customerId);
    if (!kyc.nin) {
      throw new BadRequestException(`Customer ${customerId} has no NIN captured to verify`);
    }

    kyc.ninVerifiedAt = new Date();
    kyc.ninManuallyVerifiedBy = new Types.ObjectId(verifiedBy);
    kyc.ninVerificationNote = note ?? null;
    await kyc.save();

    await this.auditService.record({
      actorId: verifiedBy,
      action: 'CUSTOMER_NIN_MANUALLY_VERIFIED',
      entityType: 'CUSTOMER',
      entityId: customerId,
      metadata: { note: note ?? null },
    });

    return kyc;
  }

  // ---------------------------------------------------------------------------
  // KYC status derivation
  // ---------------------------------------------------------------------------

  /**
   * VERIFIED iff BVN is verified (always true once a Customer exists — see
   * confirmBvnConsent) AND biometric is captured. NIN is tracked but never
   * gates this — it's the optional/manual piece of the KYC record, not a
   * precondition. See PHASE_5_NOTES.md.
   */
  async recomputeKycStatus(customerId: string): Promise<KycStatus> {
    const kyc = await this.getKycRecordOrThrow(customerId);
    const isVerified = Boolean(kyc.bvnVerifiedAt) && Boolean(kyc.biometricImageKey);
    const newStatus = isVerified ? KycStatus.VERIFIED : KycStatus.INCOMPLETE;

    if (isVerified && !kyc.kycCompletedAt) {
      kyc.kycCompletedAt = new Date();
      await kyc.save();
    }

    await this.customerModel
      .updateOne({ _id: customerId }, { $set: { kycStatus: newStatus } })
      .exec();
    return newStatus;
  }

  async isLoanEligible(customerId: string): Promise<boolean> {
    const customer = await this.findActiveDraft(customerId);
    return customer.kycStatus === KycStatus.VERIFIED;
  }

  /**
   * Opt-in per call site by design — Phase 8's cheque-pickup facial match
   * (and likely its BVN recheck) must always hit `directVerify` live
   * regardless of freshness, so this is never consulted automatically inside
   * a "verify" path; a call site either checks this first or it doesn't.
   */
  async isVerificationFresh(
    customerId: string,
    field: 'bvn' | 'nin',
    maxAgeDays: number,
  ): Promise<boolean> {
    const kyc = await this.getKycRecordOrThrow(customerId);
    const verifiedAt = field === 'bvn' ? kyc.bvnVerifiedAt : kyc.ninVerifiedAt;
    if (!verifiedAt) {
      return false;
    }
    const ageMs = Date.now() - verifiedAt.getTime();
    return ageMs <= maxAgeDays * 24 * 60 * 60 * 1000;
  }

  // ---------------------------------------------------------------------------
  // Submission
  // ---------------------------------------------------------------------------

  async submitForApproval(
    customerId: string,
    submittedBy: string,
  ): Promise<WorkflowRequestDocument> {
    const customer = await this.findActiveDraft(customerId);
    if (customer.status !== CustomerStatus.PENDING_APPROVAL) {
      throw new ConflictException(`Customer ${customerId} is not awaiting submission`);
    }

    const existing = await this.workflowEngineService.getHistory(
      WorkflowEntityType.CUSTOMER,
      customerId,
    );
    if (existing.length > 0) {
      throw new ConflictException(`Customer ${customerId} has already been submitted for approval`);
    }

    const kyc = await this.getKycRecordOrThrow(customerId);
    if (!kyc.bvnVerifiedAt) {
      // Unreachable by construction (a Customer only exists post-BVN-confirm) — defense in depth.
      throw new BadRequestException('BVN must be verified before submitting for approval');
    }
    if (!kyc.biometricImageKey) {
      throw new BadRequestException('Biometric capture is required before submitting for approval');
    }

    const request = await this.workflowEngineService.initiate({
      entityType: WorkflowEntityType.CUSTOMER,
      action: KYC_CHAIN_ACTION,
      payload: {
        customerId,
        firstName: customer.firstName,
        lastName: customer.lastName,
        phoneNumber: customer.phoneNumber,
        branchId: customer.branchId.toString(),
      },
      initiatedBy: submittedBy,
      branchId: customer.branchId.toString(),
    });

    // The entity already exists (unlike Staff/Group, where it's only created
    // on approval) — link it immediately rather than waiting for
    // workflow.approved, so getHistory works right away and a second
    // submission attempt is rejected by the check above.
    await this.workflowEngineService.linkEntity(request._id.toString(), customerId);

    await this.auditService.record({
      actorId: submittedBy,
      action: 'CUSTOMER_SUBMITTED_FOR_APPROVAL',
      entityType: 'CUSTOMER',
      entityId: customerId,
      metadata: { workflowRequestId: request._id.toString() },
    });

    return request;
  }

  @OnEvent(WORKFLOW_APPROVED_EVENT)
  async handleWorkflowApproved(event: WorkflowApprovedEvent): Promise<void> {
    if (
      (event.entityType as WorkflowEntityType) !== WorkflowEntityType.CUSTOMER ||
      event.action !== KYC_CHAIN_ACTION ||
      !event.entityId
    ) {
      return;
    }

    await this.customerModel
      .updateOne({ _id: event.entityId }, { $set: { status: CustomerStatus.ACTIVE } })
      .exec();

    await this.auditService.record({
      actorId: event.initiatedBy,
      action: 'CUSTOMER_ACTIVATED',
      entityType: 'CUSTOMER',
      entityId: event.entityId,
      after: { status: CustomerStatus.ACTIVE },
      metadata: { workflowRequestId: event.workflowRequestId },
    });
  }

  @OnEvent(WORKFLOW_REJECTED_EVENT)
  async handleWorkflowRejected(event: WorkflowRejectedEvent): Promise<void> {
    if (
      (event.entityType as WorkflowEntityType) !== WorkflowEntityType.CUSTOMER ||
      event.action !== KYC_CHAIN_ACTION ||
      !event.entityId
    ) {
      return;
    }

    await this.customerModel
      .updateOne({ _id: event.entityId }, { $set: { status: CustomerStatus.REJECTED } })
      .exec();

    await this.auditService.record({
      actorId: event.rejectedBy,
      action: 'CUSTOMER_REJECTED',
      entityType: 'CUSTOMER',
      entityId: event.entityId,
      after: { status: CustomerStatus.REJECTED },
      metadata: { workflowRequestId: event.workflowRequestId, comment: event.comment ?? null },
    });
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  async findById(customerId: string): Promise<CustomerDocument> {
    return this.findActiveDraft(customerId);
  }

  async getKycRecordOrThrow(customerId: string): Promise<KycRecordDocument> {
    // Explicit ObjectId cast, not left to Mongoose's implicit query casting —
    // found a case where a plain string filter against this non-`_id`
    // ObjectId path silently matched zero documents.
    const kyc = await this.kycRecordModel
      .findOne({ customerId: new Types.ObjectId(customerId) })
      .exec();
    if (!kyc) {
      throw new NotFoundException(`KycRecord for customer ${customerId} not found`);
    }
    return kyc;
  }

  /**
   * The single choke point for every KYC-data read — decryption and
   * signed-URL generation both go through here so the audit call can never
   * be forgotten at a new call site later (see PHASE_5_NOTES.md /
   * getDecryptedBvn / getDecryptedNin / getBiometricSignedUrl below).
   */
  private async readAndAudit<T>(
    customerId: string,
    actorId: string,
    fieldsAccessed: string[],
    reader: () => Promise<T> | T,
  ): Promise<T> {
    const result = await reader();
    await this.auditService.record({
      actorId,
      action: 'KYC_DATA_READ',
      entityType: 'CUSTOMER',
      entityId: customerId,
      metadata: { fieldsAccessed },
    });
    return result;
  }

  async getDecryptedBvn(customerId: string, actorId: string): Promise<string> {
    const kyc = await this.getKycRecordOrThrow(customerId);
    return this.readAndAudit(customerId, actorId, ['bvn'], () =>
      this.encryptionService.decrypt(kyc.bvn),
    );
  }

  async getDecryptedNin(customerId: string, actorId: string): Promise<string | null> {
    const kyc = await this.getKycRecordOrThrow(customerId);
    if (!kyc.nin) {
      return null;
    }
    const nin = kyc.nin;
    return this.readAndAudit(customerId, actorId, ['nin'], () =>
      this.encryptionService.decrypt(nin),
    );
  }

  async getDecryptedBvnConsentDetails(
    customerId: string,
    actorId: string,
  ): Promise<BvnDetails | null> {
    const kyc = await this.getKycRecordOrThrow(customerId);
    if (!kyc.bvnConsentDetailsEncrypted) {
      return null;
    }
    const ciphertext = kyc.bvnConsentDetailsEncrypted;
    return this.readAndAudit(
      customerId,
      actorId,
      ['bvnConsentDetails'],
      () => JSON.parse(this.encryptionService.decrypt(ciphertext)) as BvnDetails,
    );
  }

  async getBiometricSignedUrl(
    customerId: string,
    actorId: string,
    expiresInSeconds?: number,
  ): Promise<string | null> {
    const kyc = await this.getKycRecordOrThrow(customerId);
    if (!kyc.biometricImageKey) {
      return null;
    }
    const key = kyc.biometricImageKey;
    return this.readAndAudit(customerId, actorId, ['biometricImage'], () =>
      this.s3Adapter.getSignedReadUrl(key, expiresInSeconds),
    );
  }

  async recordBvnDirectVerifyForContext(
    customerId: string,
    context: VerificationContext,
    actorId: string,
  ): Promise<BvnDetails> {
    const kyc = await this.getKycRecordOrThrow(customerId);
    const bvn = this.encryptionService.decrypt(kyc.bvn);
    await this.auditService.record({
      actorId,
      action: 'KYC_DATA_READ',
      entityType: 'CUSTOMER',
      entityId: customerId,
      metadata: { fieldsAccessed: ['bvn'], reason: `directVerify for ${context}` },
    });

    const details = await this.bvnAdapter.directVerify(bvn, {
      calledBy: actorId,
      entityType: 'CUSTOMER',
      entityId: customerId,
    });

    kyc.bvnVerifiedAt = new Date();
    if (!kyc.lastVerifiedForContext.includes(context)) {
      kyc.lastVerifiedForContext.push(context);
    }
    await kyc.save();

    return details;
  }
}
