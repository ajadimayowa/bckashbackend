import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import type { CustomersConfig } from '../../common/config/configuration';
import { StaffRole } from '../../common/enums/identity.enums';
import { CustomerStatus, IdDocumentType, KycStatus } from '../../common/enums/customer.enums';
import { WorkflowEntityType, WorkflowStatus } from '../../common/enums/workflow.enums';
import { AuditService } from '../../platform/audit/audit.service';
import { EncryptionService } from '../../platform/encryption/encryption.service';
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
  WORKFLOW_RESUBMITTED_EVENT,
  WorkflowApprovedEvent,
  WorkflowRejectedEvent,
  WorkflowResubmittedEvent,
} from '../../platform/workflow-engine/events/workflow-engine.events';
import { WorkflowEngineService } from '../../platform/workflow-engine/workflow-engine.service';
import { WorkflowRequestDocument } from '../../platform/workflow-engine/schemas/workflow-request.schema';
// Cross-module read only — the raw Branch model, same pattern established in
// Phase 3/4 (see identity/staff.service.ts, branches/branch-manager-assignment.service.ts).
import { Branch, BranchDocument } from '../branches/schemas/branch.schema';
// Cross-module read only, same pattern as the Branch import above — just
// resolving actorId -> display name for the audit trail, without pulling in
// the full StaffService (its own GET /staff endpoints are
// ORG_MANAGE_CAPABILITY-gated, which a Marketer viewing their own
// customer's audit trail never holds — and its constructor drags in
// Departments/Units/RefreshToken plus four more injected models, which
// would be a lot of unrelated DI weight for a name lookup).
import { Staff, StaffDocument } from '../identity/schemas/staff.schema';
// Cross-module read only, same pattern as Branch/Staff above — resolving a
// customer's current group name without depending on GroupsModule itself
// (GroupsModule already imports CustomersModule; the reverse would be
// circular — see GroupsModule's own comment on this same principle).
import { GroupMembership, GroupMembershipDocument } from '../groups/schemas/group-membership.schema';
import { Group, GroupDocument } from '../groups/schemas/group.schema';
import { VerificationContext } from './enums/verification-context.enum';
import {
  BVN_VERIFICATION_PREVIEW_TTL_MS,
  BvnVerificationPreview,
  BvnVerificationPreviewDocument,
} from './schemas/bvn-verification-preview.schema';
import { Customer, CustomerDocument, EditPrivilegeStatus } from './schemas/customer.schema';
import { KycRecord, KycRecordDocument, MismatchFlag } from './schemas/kyc-record.schema';

const KYC_CHAIN_ACTION = 'CREATE';

/** Same "single word becomes both first and last name" rule the frontend's own splitCustomerName uses — kept consistent so a one-word submission doesn't produce an empty lastName. */
function splitFullName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return { firstName: '', lastName: '' };
  }
  if (parts.length === 1) {
    return { firstName: parts[0]!, lastName: parts[0]! };
  }
  return { firstName: parts[0]!, lastName: parts.slice(1).join(' ') };
}

export interface ConfirmBvnConsentResult {
  customer: CustomerDocument;
  mismatchFlags: MismatchFlag[];
}

export interface ResolveIdentityMismatchInput {
  /** false = keep the provider's resolved values (already on the Customer record, no reason needed). true = overwrite with what was submitted — requires `reason`. */
  useSubmittedValues: boolean;
  fullName?: string;
  phoneNumber?: string;
  reason?: string;
}

export interface UpdateOnboardingDetailsInput {
  address?: string;
  email?: string;
  nin?: string;
  nextOfKin?: { fullName: string; phoneNumber: string; relationship?: string };
  guarantors?: Array<{
    fullName: string;
    phoneNumber: string;
    email?: string;
    address?: string;
    relationship?: string;
    occupation?: string;
  }>;
  reference?: {
    fullName: string;
    phoneNumber: string;
    address?: string;
    relationship?: string;
    occupation?: string;
    yearsKnown?: string;
  };
}

/** What CustomerController's guards resolve about the caller — enough to decide read/list scope without a second RBAC round-trip. */
export interface CustomerViewerContext {
  staffId: string;
  role: StaffRole;
  branchId?: string;
}

export interface FindCustomersFilter {
  branchId?: string;
  createdById?: string;
}

@Injectable()
export class CustomerService implements OnModuleInit {
  private readonly customersConfig: CustomersConfig;

  constructor(
    @InjectModel(Customer.name) private readonly customerModel: Model<CustomerDocument>,
    @InjectModel(KycRecord.name) private readonly kycRecordModel: Model<KycRecordDocument>,
    @InjectModel(BvnVerificationPreview.name)
    private readonly bvnVerificationPreviewModel: Model<BvnVerificationPreviewDocument>,
    @InjectModel(Branch.name) private readonly branchModel: Model<BranchDocument>,
    @InjectModel(Staff.name) private readonly staffModel: Model<StaffDocument>,
    @InjectModel(Group.name) private readonly groupModel: Model<GroupDocument>,
    @InjectModel(GroupMembership.name) private readonly groupMembershipModel: Model<GroupMembershipDocument>,
    @Inject(BVN_VERIFICATION_ADAPTER) private readonly bvnAdapter: BvnVerificationAdapter,
    @Inject(S3_ADAPTER) private readonly s3Adapter: S3Adapter,
    private readonly encryptionService: EncryptionService,
    private readonly auditService: AuditService,
    private readonly workflowEngineService: WorkflowEngineService,
    private readonly configService: ConfigService,
  ) {
    this.customersConfig = this.configService.get<CustomersConfig>('customers') ?? {
      enforceUniquePhoneNumber: true,
    };
  }

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
  // Step 1: BVN verification + customer creation
  // ---------------------------------------------------------------------------

  /**
   * Diffs `submitted.fullName`/`phoneNumber` (what the marketer typed at
   * intake — see VerifyBvnDto) against the provider's own resolved
   * name/phone. Deliberately lenient normalization (case/whitespace-
   * insensitive for name, last-10-digits for phone, so a leading 0 vs a
   * 234 country code doesn't false-positive) — the point is to flag
   * something for human review, not to auto-reject, so an over-eager
   * exact-match would just create noise. Returns [] (no flags recorded at
   * all) when nothing was submitted to compare against.
   */
  private buildMismatchFlags(
    submitted: { fullName?: string; phoneNumber?: string },
    resolved: { firstName: string; lastName: string; phoneNumber: string },
  ): MismatchFlag[] {
    const flags: MismatchFlag[] = [];
    const normalizeName = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');
    const normalizePhone = (value: string) => value.replace(/\D/g, '').slice(-10);

    if (submitted.fullName) {
      const resolvedFullName = `${resolved.firstName} ${resolved.lastName}`;
      if (normalizeName(submitted.fullName) !== normalizeName(resolvedFullName)) {
        flags.push({
          field: 'fullName',
          submitted: submitted.fullName,
          providerValue: resolvedFullName,
          resolvedAt: null,
          resolvedBy: null,
          resolution: null,
          reason: null,
        });
      }
    }
    if (submitted.phoneNumber) {
      if (normalizePhone(submitted.phoneNumber) !== normalizePhone(resolved.phoneNumber)) {
        flags.push({
          field: 'phoneNumber',
          submitted: submitted.phoneNumber,
          providerValue: resolved.phoneNumber,
          resolvedAt: null,
          resolvedBy: null,
          resolution: null,
          reason: null,
        });
      }
    }
    return flags;
  }

  /**
   * No two customers may share a phone number — checked wherever a
   * Customer's `phoneNumber` is actually set (creation from the BVN
   * provider's resolved value, and later overridden via
   * resolveIdentityMismatch's `useSubmittedValues`), not just at intake.
   * `excludeCustomerId` lets a mismatch-resolution keep a customer's own
   * already-registered number if it happens to be unchanged.
   *
   * Gated on CUSTOMER_ENFORCE_UNIQUE_PHONE (default true) — see
   * env.validation.ts's own doc comment for why this is an env toggle at
   * all rather than an unconditional rule.
   */
  private async assertPhoneNumberAvailable(phoneNumber: string, excludeCustomerId?: string): Promise<void> {
    if (!this.customersConfig.enforceUniquePhoneNumber) {
      return;
    }
    const filter: Record<string, unknown> = { phoneNumber };
    if (excludeCustomerId) {
      filter._id = { $ne: new Types.ObjectId(excludeCustomerId) };
    }
    const existing = await this.customerModel.exists(filter);
    if (existing) {
      throw new ConflictException(`A customer with phone number ${phoneNumber} already exists`);
    }
  }

  /**
   * Shared by verifyBvnAndCreateCustomer (still a one-shot "verify AND
   * create" helper — kept exactly as-is; it's a widely-used test fixture
   * builder, see repayments-test-context.ts) and previewBvn (the real
   * onboarding UI's own entry point as of the "don't create until
   * confirmed" change — see previewBvn's own doc comment): branch must
   * exist, the BVN must not already be registered (checked before even
   * calling the provider — saves a provider call on a known duplicate), and
   * whatever phone number the provider resolves must not already be
   * registered either.
   */
  private async resolveBvnDetails(
    bvn: string,
    branchId: string,
    initiatedBy: string,
  ): Promise<{ bvnHash: string; details: BvnDetails }> {
    const branchExists = await this.branchModel.exists({ _id: branchId });
    if (!branchExists) {
      throw new BadRequestException(`Branch ${branchId} does not exist`);
    }

    const bvnHash = this.encryptionService.hash(bvn);
    const alreadyRegistered = await this.kycRecordModel.exists({ bvnHash });
    if (alreadyRegistered) {
      throw new ConflictException('This BVN is already registered to another customer');
    }

    const details = await this.bvnAdapter.directVerify(bvn, {
      calledBy: initiatedBy,
      entityType: 'CUSTOMER',
    });

    // Only knowable once the provider resolves the real phone number (what's
    // submitted here is just self-reported, for mismatch-flagging purposes —
    // see buildMismatchFlags) — no two customers may share one, same
    // "one real person, one record" reasoning as the BVN check above.
    await this.assertPhoneNumberAvailable(details.phoneNumber);

    return { bvnHash, details };
  }

  /**
   * *** TEST FIXTURE HELPER — NOT the real onboarding UI's entry point any
   * more, see previewBvn/confirmCustomerFromPreview below for that. ***
   * Kept exactly as it always behaved (verify AND create the Customer +
   * KycRecord in one call, immediately, no confirmation step) purely
   * because it's used as a one-shot fixture builder throughout the test
   * suite (repayments-test-context.ts's createVerifiedCustomerWithBiometrics
   * chief among them) — changing its behavior would ripple through every
   * spec that builds a customer this way. `BvnInvalidException`/
   * `BvnProviderUnavailableException` propagate as-is on failure, with
   * nothing persisted.
   */
  async verifyBvnAndCreateCustomer(
    bvn: string,
    branchId: string,
    initiatedBy: string,
    submitted?: { fullName?: string; phoneNumber?: string },
  ): Promise<ConfirmBvnConsentResult> {
    const { bvnHash, details } = await this.resolveBvnDetails(bvn, branchId, initiatedBy);

    const now = new Date();
    const customer = await this.customerModel.create({
      firstName: details.firstName,
      lastName: details.lastName,
      phoneNumber: details.phoneNumber,
      branchId: new Types.ObjectId(branchId),
      status: CustomerStatus.PENDING_APPROVAL,
      kycStatus: KycStatus.INCOMPLETE,
      createdBy: new Types.ObjectId(initiatedBy),
    });

    const mismatchFlags = this.buildMismatchFlags(submitted ?? {}, {
      firstName: details.firstName,
      lastName: details.lastName,
      phoneNumber: details.phoneNumber,
    });

    await this.kycRecordModel.create({
      customerId: customer._id,
      bvn: this.encryptionService.encrypt(details.bvn),
      bvnHash,
      bvnConsentDetailsEncrypted: this.encryptionService.encrypt(JSON.stringify(details)),
      bvnVerifiedAt: now,
      mismatchFlags,
      lastVerifiedForContext: [VerificationContext.KYC_CAPTURE],
    });

    await this.auditService.record({
      actorId: initiatedBy,
      action: 'CUSTOMER_CREATED_VIA_BVN_VERIFICATION',
      entityType: 'CUSTOMER',
      entityId: customer._id.toString(),
      after: { phoneNumber: details.phoneNumber, branchId },
      metadata: mismatchFlags.length > 0 ? { mismatchFlags } : undefined,
    });

    return { customer, mismatchFlags };
  }

  /**
   * The real onboarding UI's own "step 1" — verifies a BVN against the
   * provider and computes mismatchFlags against whatever was submitted at
   * intake, exactly like verifyBvnAndCreateCustomer above, but deliberately
   * does NOT create a Customer or KycRecord. Persists a short-lived
   * BvnVerificationPreview instead (TTL-indexed, auto-expires — see that
   * schema's own doc comment) so the marketer/manager can review what came
   * back before anything is actually written to the real record — the
   * record only gets created once they explicitly pick a side via
   * confirmCustomerFromPreview below, whether or not anything was even
   * flagged as mismatched (product decision: "don't create just because
   * the BVN verified" applies to the no-mismatch path too, not only the
   * mismatch-resolution one).
   */
  async previewBvn(
    bvn: string,
    branchId: string,
    initiatedBy: string,
    submitted?: { fullName?: string; phoneNumber?: string },
  ): Promise<{
    previewId: string;
    resolved: { firstName: string; lastName: string; phoneNumber: string };
    mismatchFlags: MismatchFlag[];
    expiresAt: Date;
  }> {
    const { bvnHash, details } = await this.resolveBvnDetails(bvn, branchId, initiatedBy);

    const mismatchFlags = this.buildMismatchFlags(submitted ?? {}, {
      firstName: details.firstName,
      lastName: details.lastName,
      phoneNumber: details.phoneNumber,
    });

    const expiresAt = new Date(Date.now() + BVN_VERIFICATION_PREVIEW_TTL_MS);
    const preview = await this.bvnVerificationPreviewModel.create({
      branchId: new Types.ObjectId(branchId),
      verifiedBy: new Types.ObjectId(initiatedBy),
      bvnEncrypted: this.encryptionService.encrypt(details.bvn),
      bvnHash,
      firstName: details.firstName,
      lastName: details.lastName,
      phoneNumber: details.phoneNumber,
      rawDetailsEncrypted: this.encryptionService.encrypt(JSON.stringify(details)),
      mismatchFlags,
      expiresAt,
    });

    return {
      previewId: preview._id.toString(),
      resolved: { firstName: details.firstName, lastName: details.lastName, phoneNumber: details.phoneNumber },
      mismatchFlags,
      expiresAt,
    };
  }

  /**
   * The real onboarding UI's own "step 2" — the moment a Customer + KycRecord
   * actually get created, from a still-live, not-yet-consumed
   * BvnVerificationPreview (see previewBvn above). Same choice/validation
   * shape as resolveIdentityMismatch (provider's values by default, no
   * reason needed; submitted values require a reason and only for whichever
   * fields were actually flagged), just applied before creation rather than
   * as a later patch — so a resolved mismatchFlags entry, if any, is present
   * on the KycRecord from the moment it exists, never in a transient
   * unresolved state.
   */
  async confirmCustomerFromPreview(
    previewId: string,
    confirmedBy: string,
    input: ResolveIdentityMismatchInput,
  ): Promise<ConfirmBvnConsentResult> {
    const preview = await this.bvnVerificationPreviewModel.findById(previewId).exec();
    if (!preview) {
      throw new NotFoundException(`BVN verification preview ${previewId} not found — it may have expired`);
    }
    if (preview.consumedAt) {
      throw new ConflictException(`BVN verification preview ${previewId} has already been used`);
    }
    if (preview.expiresAt.getTime() <= Date.now()) {
      throw new ConflictException(`BVN verification preview ${previewId} has expired — verify the BVN again`);
    }
    // Only the staff member who actually verified this BVN may confirm it —
    // same "maker" as the rest of this two-step flow, not just anyone who
    // guesses/reuses a preview id.
    if (preview.verifiedBy.toString() !== confirmedBy) {
      throw new ForbiddenException('Only the staff member who verified this BVN may confirm it');
    }

    // Re-checked here, not just at preview time — another confirmation for
    // the same BVN could have completed in the meantime.
    const alreadyRegistered = await this.kycRecordModel.exists({ bvnHash: preview.bvnHash });
    if (alreadyRegistered) {
      throw new ConflictException('This BVN is already registered to another customer');
    }

    const unresolvedFields = new Set(preview.mismatchFlags.map((flag) => flag.field));
    let firstName = preview.firstName;
    let lastName = preview.lastName;
    let phoneNumber = preview.phoneNumber;

    if (input.useSubmittedValues) {
      if (!input.reason || input.reason.trim().length < 3) {
        throw new BadRequestException("A reason is required to use the submitted details over the provider's");
      }
      if (unresolvedFields.has('fullName')) {
        if (!input.fullName?.trim()) {
          throw new BadRequestException('fullName is required to resolve the flagged name mismatch');
        }
        const split = splitFullName(input.fullName);
        firstName = split.firstName;
        lastName = split.lastName;
      }
      if (unresolvedFields.has('phoneNumber')) {
        if (!input.phoneNumber?.trim()) {
          throw new BadRequestException('phoneNumber is required to resolve the flagged phone mismatch');
        }
        phoneNumber = input.phoneNumber.trim();
      }
    }

    // Whichever phone will actually be persisted must still be free —
    // re-checked here for the same "don't just trust the preview-time
    // snapshot" reasoning as the BVN re-check above (and doubly so when
    // useSubmittedValues just swapped in a phone that was never checked at
    // preview time at all).
    await this.assertPhoneNumberAvailable(phoneNumber);

    const now = new Date();
    const customer = await this.customerModel.create({
      firstName,
      lastName,
      phoneNumber,
      branchId: preview.branchId,
      status: CustomerStatus.DRAFT,
      kycStatus: KycStatus.INCOMPLETE,
      createdBy: new Types.ObjectId(confirmedBy),
    });

    const resolution = input.useSubmittedValues ? 'USED_SUBMITTED_VALUE' : 'KEPT_PROVIDER_VALUE';
    const mismatchFlags: MismatchFlag[] = preview.mismatchFlags.map((flag) => ({
      field: flag.field,
      submitted: flag.submitted,
      providerValue: flag.providerValue,
      resolvedAt: now,
      resolvedBy: new Types.ObjectId(confirmedBy),
      resolution,
      reason: input.useSubmittedValues ? input.reason!.trim() : null,
    }));

    await this.kycRecordModel.create({
      customerId: customer._id,
      bvn: preview.bvnEncrypted,
      bvnHash: preview.bvnHash,
      bvnConsentDetailsEncrypted: preview.rawDetailsEncrypted,
      bvnVerifiedAt: preview.createdAt,
      mismatchFlags,
      lastVerifiedForContext: [VerificationContext.KYC_CAPTURE],
    });

    preview.consumedAt = now;
    await preview.save();

    await this.auditService.record({
      actorId: confirmedBy,
      action: 'CUSTOMER_CREATED_VIA_BVN_VERIFICATION',
      entityType: 'CUSTOMER',
      entityId: customer._id.toString(),
      after: { phoneNumber, branchId: preview.branchId.toString() },
      metadata: mismatchFlags.length > 0 ? { mismatchFlags } : undefined,
    });

    return { customer, mismatchFlags };
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

  /**
   * Only the maker who created a customer record may edit/submit it — a
   * *different* Marketer/Manager who happens to also hold `INITIATE_CUSTOMER`
   * cannot, even though the capability alone would otherwise let them
   * through. Deliberately not extended to the approval-side actions
   * (manuallyVerifyNin, disable/enable) — those are Admin/Approver-tier
   * actions on someone else's record by design.
   */
  private assertIsCreator(customer: CustomerDocument, actorId: string): void {
    if (customer.createdBy.toString() !== actorId) {
      throw new ForbiddenException('Only the staff member who created this customer record may update it');
    }
  }

  async updateOnboardingDetails(
    customerId: string,
    input: UpdateOnboardingDetailsInput,
    updatedBy: string,
  ): Promise<CustomerDocument> {
    const customer = await this.findActiveDraft(customerId);
    this.assertIsCreator(customer, updatedBy);
    // A REJECTED customer's creator can still edit — that's the whole point
    // of the resubmission flow (see resubmitForApproval's own comment):
    // fix whatever the reviewer/approver flagged, then resubmit for a fresh
    // review cycle. An ACTIVE (already-approved) one is locked unless an
    // Admin/SuperAdmin/Approver has granted a one-shot edit privilege —
    // see EditPrivilege's own doc comment. Consumed below, on success.
    const usingGrantedPrivilege = customer.status === CustomerStatus.ACTIVE;
    if (usingGrantedPrivilege && customer.editPrivilege.status !== EditPrivilegeStatus.GRANTED) {
      throw new ConflictException(
        `Customer ${customerId} is already approved — request edit privilege before updating their details`,
      );
    }

    if (input.address !== undefined) {
      customer.address = input.address;
    }
    if (input.email !== undefined) {
      customer.email = input.email.toLowerCase();
    }
    if (input.nextOfKin !== undefined) {
      customer.nextOfKin = {
        fullName: input.nextOfKin.fullName,
        phoneNumber: input.nextOfKin.phoneNumber,
        relationship: input.nextOfKin.relationship ?? null,
      };
    }
    if (input.guarantors !== undefined) {
      customer.guarantors = input.guarantors.map((guarantor) => ({
        fullName: guarantor.fullName,
        phoneNumber: guarantor.phoneNumber,
        email: guarantor.email ?? null,
        address: guarantor.address ?? null,
        relationship: guarantor.relationship ?? null,
        occupation: guarantor.occupation ?? null,
      }));
    }
    if (input.reference !== undefined) {
      customer.reference = {
        fullName: input.reference.fullName,
        phoneNumber: input.reference.phoneNumber,
        address: input.reference.address ?? null,
        relationship: input.reference.relationship ?? null,
        occupation: input.reference.occupation ?? null,
        yearsKnown: input.reference.yearsKnown ?? null,
      };
    }
    await customer.save();

    if (input.nin !== undefined) {
      await this.recordNin(customerId, input.nin, updatedBy);
    }

    await this.consumeEditPrivilegeIfUsed(customer);
    return customer;
  }

  /**
   * Flips a GRANTED edit privilege back to NONE the moment it's actually
   * used, so each further edit needs a fresh request+approval. A no-op for
   * anything else (PENDING_APPROVAL/REJECTED customer, or no privilege in
   * play) — idempotent, safe to call from both updateOnboardingDetails and
   * recordNin even though the former can call into the latter.
   */
  private async consumeEditPrivilegeIfUsed(customer: CustomerDocument): Promise<void> {
    if (customer.status !== CustomerStatus.ACTIVE || customer.editPrivilege.status !== EditPrivilegeStatus.GRANTED) {
      return;
    }
    customer.editPrivilege.status = EditPrivilegeStatus.NONE;
    await customer.save();
  }

  /**
   * Creator-only, ACTIVE customers only (there's nothing to "privilege" for
   * a still-PENDING/REJECTED one — those are already editable outright).
   * Uploads the customer's signature the same way captureBiometric uploads
   * a biometric image — `kyc/{customerId}/edit-privilege-signature/...`.
   */
  async requestEditPrivilege(
    customerId: string,
    reason: string,
    signatureBuffer: Buffer,
    contentType: string,
    requestedBy: string,
  ): Promise<CustomerDocument> {
    const customer = await this.findActiveDraft(customerId);
    this.assertIsCreator(customer, requestedBy);
    if (customer.status !== CustomerStatus.ACTIVE) {
      throw new ConflictException(
        `Customer ${customerId} is not yet approved — its details are already editable directly`,
      );
    }
    if (customer.editPrivilege.status === EditPrivilegeStatus.PENDING) {
      throw new ConflictException('An edit privilege request is already pending for this customer');
    }

    const extension = contentType.split('/')[1] ?? 'jpg';
    const key = buildKycObjectKey(customerId, 'edit-privilege-signature', extension);
    await this.s3Adapter.upload(key, signatureBuffer, contentType);

    customer.editPrivilege = {
      status: EditPrivilegeStatus.PENDING,
      reason,
      signatureImageKey: key,
      requestedBy: new Types.ObjectId(requestedBy),
      requestedAt: new Date(),
      decidedBy: null,
      decidedAt: null,
      decisionComment: null,
    };
    await customer.save();

    await this.auditService.record({
      actorId: requestedBy,
      action: 'CUSTOMER_EDIT_PRIVILEGE_REQUESTED',
      entityType: 'CUSTOMER',
      entityId: customerId,
      after: { reason },
    });

    return customer;
  }

  /**
   * Admin/SuperAdmin/Approver only (gated by the controller's
   * `@RequireCapability(APPROVE_CUSTOMER)`, same tier as disable/enable —
   * independent of the onboarding workflow, not a multi-step chain).
   */
  async decideEditPrivilege(
    customerId: string,
    approve: boolean,
    comment: string | undefined,
    decidedBy: string,
  ): Promise<CustomerDocument> {
    const customer = await this.findActiveDraft(customerId);
    if (customer.editPrivilege.status !== EditPrivilegeStatus.PENDING) {
      throw new ConflictException(`Customer ${customerId} has no pending edit privilege request`);
    }

    customer.editPrivilege.status = approve ? EditPrivilegeStatus.GRANTED : EditPrivilegeStatus.REJECTED;
    customer.editPrivilege.decidedBy = new Types.ObjectId(decidedBy);
    customer.editPrivilege.decidedAt = new Date();
    customer.editPrivilege.decisionComment = comment?.trim() || null;
    await customer.save();

    await this.auditService.record({
      actorId: decidedBy,
      action: approve ? 'CUSTOMER_EDIT_PRIVILEGE_GRANTED' : 'CUSTOMER_EDIT_PRIVILEGE_REJECTED',
      entityType: 'CUSTOMER',
      entityId: customerId,
      metadata: { comment: comment?.trim() || null },
    });

    return customer;
  }

  /** Admin/SuperAdmin/Approver only, same tier as decideEditPrivilege — for reviewing the request before deciding. */
  async getEditPrivilegeSignatureUrl(customerId: string, expiresInSeconds?: number): Promise<string | null> {
    const customer = await this.findActiveDraft(customerId);
    if (!customer.editPrivilege.signatureImageKey) {
      return null;
    }
    return this.s3Adapter.getSignedReadUrl(customer.editPrivilege.signatureImageKey, expiresInSeconds);
  }

  async captureBiometric(
    customerId: string,
    imageBuffer: Buffer,
    contentType: string,
    capturedBy: string,
  ): Promise<KycRecordDocument> {
    const customer = await this.findActiveDraft(customerId);
    this.assertIsCreator(customer, capturedBy);
    // DRAFT is the normal case (still mid-onboarding); REJECTED is allowed
    // too — recapturing is part of fixing what a reviewer/approver flagged
    // before resubmitForApproval. See its own comment. PENDING_APPROVAL is
    // also accepted for the legacy verifyBvnAndCreateCustomer fixture path,
    // which creates a customer already past DRAFT — see its own comment.
    if (
      customer.status !== CustomerStatus.DRAFT &&
      customer.status !== CustomerStatus.PENDING_APPROVAL &&
      customer.status !== CustomerStatus.REJECTED
    ) {
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

  /**
   * A photo of the customer's ID document (NIN slip, voter's card, ...) —
   * same creator-only/PENDING_APPROVAL-only/upload-then-audit shape as
   * captureBiometric, but never gates kycStatus (recomputeKycStatus is
   * deliberately not called here — only BVN + biometric do that, see its
   * own doc comment).
   */
  async captureIdDocument(
    customerId: string,
    imageBuffer: Buffer,
    contentType: string,
    capturedBy: string,
    documentType?: IdDocumentType,
  ): Promise<KycRecordDocument> {
    const customer = await this.findActiveDraft(customerId);
    this.assertIsCreator(customer, capturedBy);
    // Same DRAFT/PENDING_APPROVAL/REJECTED acceptance as captureBiometric —
    // see its own comment.
    if (
      customer.status !== CustomerStatus.DRAFT &&
      customer.status !== CustomerStatus.PENDING_APPROVAL &&
      customer.status !== CustomerStatus.REJECTED
    ) {
      throw new ConflictException(
        `Customer ${customerId} is not in a state that accepts KYC capture`,
      );
    }

    const extension = contentType.split('/')[1] ?? 'jpg';
    const key = buildKycObjectKey(customerId, 'id-document', extension);
    await this.s3Adapter.upload(key, imageBuffer, contentType);

    const kyc = await this.getKycRecordOrThrow(customerId);
    kyc.idDocumentImageKey = key;
    if (documentType) {
      kyc.idDocumentType = documentType;
    }
    await kyc.save();

    await this.auditService.record({
      actorId: capturedBy,
      action: 'CUSTOMER_ID_DOCUMENT_CAPTURED',
      entityType: 'CUSTOMER',
      entityId: customerId,
      metadata: { key },
    });

    return kyc;
  }

  // ---------------------------------------------------------------------------
  // NIN — optional, manually verified, never gates kycStatus
  // ---------------------------------------------------------------------------

  async recordNin(customerId: string, nin: string, capturedBy: string): Promise<KycRecordDocument> {
    const customer = await this.findActiveDraft(customerId);
    this.assertIsCreator(customer, capturedBy);
    // REJECTED is allowed too — see resubmitForApproval's own comment. An
    // ACTIVE customer needs a GRANTED edit privilege first — see
    // updateOnboardingDetails' own comment (same gate, since this is
    // reachable both standalone and nested inside that call).
    if (customer.status === CustomerStatus.ACTIVE && customer.editPrivilege.status !== EditPrivilegeStatus.GRANTED) {
      throw new ConflictException(
        `Customer ${customerId} is already approved — request edit privilege before updating their NIN`,
      );
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

    await this.consumeEditPrivilegeIfUsed(customer);
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
   *
   * MISMATCH_FLAGGED overrides VERIFIED (never INCOMPLETE — an incomplete
   * record has nothing to gate yet) whenever an *unresolved* mismatch flag
   * exists — this is the producer that enum value never had before
   * submitted-vs-provider comparison existed (see customer.enums.ts's own
   * doc comment). Once every flag is resolved (either
   * resolveIdentityMismatch outcome), this clears back to VERIFIED — the
   * flags themselves stay on the record as an audit trail regardless.
   * isLoanEligible only accepts VERIFIED, so an *unresolved* mismatch
   * blocks loan eligibility even with BVN + biometric both done.
   */
  async recomputeKycStatus(customerId: string): Promise<KycStatus> {
    const kyc = await this.getKycRecordOrThrow(customerId);
    const isVerified = Boolean(kyc.bvnVerifiedAt) && Boolean(kyc.biometricImageKey);
    const hasUnresolvedMismatch = kyc.mismatchFlags.some((flag) => !flag.resolvedAt);
    const newStatus = !isVerified
      ? KycStatus.INCOMPLETE
      : hasUnresolvedMismatch
        ? KycStatus.MISMATCH_FLAGGED
        : KycStatus.VERIFIED;

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
    this.assertIsCreator(customer, submittedBy);
    // DRAFT is the normal pre-submission state (see CustomerStatus.DRAFT's
    // own doc comment). PENDING_APPROVAL is also accepted here so the
    // legacy verifyBvnAndCreateCustomer test fixture — which is frozen to
    // create a customer already at PENDING_APPROVAL, skipping DRAFT
    // entirely, see its own comment — can still submit; the $set below is
    // then just a harmless no-op for that path.
    if (customer.status !== CustomerStatus.DRAFT && customer.status !== CustomerStatus.PENDING_APPROVAL) {
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

    // The actual DRAFT -> PENDING_APPROVAL transition — this is the moment
    // the record becomes visible to Managers/Admins/Approvers at all (see
    // findAllForActor).
    customer.status = CustomerStatus.PENDING_APPROVAL;
    await customer.save();

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

  /**
   * The creator's path back in after a REJECTED KYC submission — edit the
   * flagged details first (updateOnboardingDetails/captureBiometric/etc. no
   * longer block on REJECTED, see their own comments), then call this to
   * send it through a *fresh* review cycle (WorkflowEngineService.resubmit
   * always restarts a REJECTED request from step 0 — see its own comment).
   * `handleWorkflowResubmitted` below flips the Customer back to
   * PENDING_APPROVAL once the engine confirms the resubmission went through.
   */
  async resubmitForApproval(
    customerId: string,
    submittedBy: string,
  ): Promise<WorkflowRequestDocument> {
    const customer = await this.findActiveDraft(customerId);
    this.assertIsCreator(customer, submittedBy);
    if (customer.status !== CustomerStatus.REJECTED) {
      throw new ConflictException(`Customer ${customerId} is not in a rejected state to resubmit`);
    }

    const kyc = await this.getKycRecordOrThrow(customerId);
    if (!kyc.bvnVerifiedAt) {
      throw new BadRequestException('BVN must be verified before resubmitting for approval');
    }
    if (!kyc.biometricImageKey) {
      throw new BadRequestException('Biometric capture is required before resubmitting for approval');
    }

    const history = await this.workflowEngineService.getHistory(WorkflowEntityType.CUSTOMER, customerId);
    const latest = history[history.length - 1];
    if (!latest) {
      throw new ConflictException(`Customer ${customerId} has no prior submission to resubmit`);
    }

    const request = await this.workflowEngineService.resubmit({
      workflowRequestId: latest._id.toString(),
      actorId: submittedBy,
      newPayload: {
        customerId,
        firstName: customer.firstName,
        lastName: customer.lastName,
        phoneNumber: customer.phoneNumber,
        branchId: customer.branchId.toString(),
      },
    });

    await this.auditService.record({
      actorId: submittedBy,
      action: 'CUSTOMER_RESUBMITTED_FOR_APPROVAL',
      entityType: 'CUSTOMER',
      entityId: customerId,
      metadata: { workflowRequestId: request._id.toString() },
    });

    return request;
  }

  /**
   * Creator only, and only before the record has ever gone ACTIVE — a
   * Marketer withdrawing a draft or REJECTED submission raised by mistake,
   * not a generic "remove any customer" admin action (there is none; see
   * disable/enable for an ACTIVE customer's equivalent). If a submission is
   * still sitting in someone else's review/approval queue (PENDING_REVIEW/
   * PENDING_APPROVAL/RETURNED_TO_MAKER), its WorkflowRequest is cancelled
   * first so it stops showing up there — a REJECTED customer's linked
   * request is already terminal and is simply left as historical audit
   * trail (its `entityId` will just no longer resolve).
   */
  async deleteCustomer(customerId: string, actorId: string): Promise<void> {
    const customer = await this.findActiveDraft(customerId);
    this.assertIsCreator(customer, actorId);
    if (
      customer.status !== CustomerStatus.DRAFT &&
      customer.status !== CustomerStatus.PENDING_APPROVAL &&
      customer.status !== CustomerStatus.REJECTED
    ) {
      throw new ConflictException(
        `Customer ${customerId} has already been approved and can no longer be deleted`,
      );
    }

    const history = await this.workflowEngineService.getHistory(WorkflowEntityType.CUSTOMER, customerId);
    const activeRequest = history.find(
      (request) =>
        request.status === WorkflowStatus.PENDING_REVIEW ||
        request.status === WorkflowStatus.PENDING_APPROVAL ||
        request.status === WorkflowStatus.RETURNED_TO_MAKER,
    );
    if (activeRequest) {
      await this.workflowEngineService.cancel({
        workflowRequestId: activeRequest._id.toString(),
        actorId,
      });
    }

    await this.kycRecordModel.deleteOne({ customerId: new Types.ObjectId(customerId) }).exec();
    await this.customerModel.deleteOne({ _id: customerId }).exec();

    await this.auditService.record({
      actorId,
      action: 'CUSTOMER_DELETED',
      entityType: 'CUSTOMER',
      entityId: customerId,
      before: { status: customer.status },
      metadata: { firstName: customer.firstName, lastName: customer.lastName },
    });
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

  @OnEvent(WORKFLOW_RESUBMITTED_EVENT)
  async handleWorkflowResubmitted(event: WorkflowResubmittedEvent): Promise<void> {
    if (
      (event.entityType as WorkflowEntityType) !== WorkflowEntityType.CUSTOMER ||
      event.action !== KYC_CHAIN_ACTION ||
      !event.entityId
    ) {
      return;
    }

    await this.customerModel
      .updateOne({ _id: event.entityId }, { $set: { status: CustomerStatus.PENDING_APPROVAL } })
      .exec();

    await this.auditService.record({
      actorId: event.resubmittedBy,
      action: 'CUSTOMER_RESUBMISSION_ACCEPTED',
      entityType: 'CUSTOMER',
      entityId: event.entityId,
      after: { status: CustomerStatus.PENDING_APPROVAL },
      metadata: { workflowRequestId: event.workflowRequestId },
    });
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  async findById(customerId: string): Promise<CustomerDocument> {
    return this.findActiveDraft(customerId);
  }

  /**
   * `assertCanView` gives every role read access to a customer record they're
   * entitled to see, not "everybody sees everything": ADMIN/SUPERADMIN/APPROVER
   * unrestricted; MANAGER only their own branch; everyone else (MARKETER)
   * only records they themselves created. See CustomerViewerContext.
   */
  private assertCanView(customer: CustomerDocument, viewer: CustomerViewerContext): void {
    if (viewer.role === StaffRole.ADMIN || viewer.role === StaffRole.SUPERADMIN || viewer.role === StaffRole.APPROVER) {
      return;
    }
    if (viewer.role === StaffRole.MANAGER) {
      if (viewer.branchId && customer.branchId.toString() === viewer.branchId) {
        return;
      }
      throw new ForbiddenException('You may only view customers created in your own branch');
    }
    if (customer.createdBy.toString() === viewer.staffId) {
      return;
    }
    throw new ForbiddenException('You may only view customer records you created');
  }

  async findByIdForActor(customerId: string, viewer: CustomerViewerContext): Promise<CustomerDocument> {
    const customer = await this.findActiveDraft(customerId);
    this.assertCanView(customer, viewer);
    return customer;
  }

  /**
   * Every recorded action on this customer — onboarding edits, KYC
   * captures, submissions, workflow decisions, mismatch resolutions, KYC
   * data reads — oldest first. Same view permission as findByIdForActor
   * (whoever can see the customer can see its trail); no extra capability.
   */
  async getAuditTrail(customerId: string, viewer: CustomerViewerContext) {
    await this.findByIdForActor(customerId, viewer);
    return this.auditService.findByEntity('CUSTOMER', customerId);
  }

  /**
   * `id -> "First Last"` for a batch of staff ids — used to attach a
   * display name onto raw `actorId`/`initiatedBy`/etc. fields in a response
   * DTO (e.g. CustomerAuditEntryDto.actorName) without ever widening who can
   * call the ORG_MANAGE_CAPABILITY-gated `/staff` endpoints themselves. Any
   * id with no matching Staff (deleted, or simply not found) is just absent
   * from the returned map — callers fall back to the raw id.
   */
  async resolveStaffNames(staffIds: string[]): Promise<Map<string, string>> {
    const uniqueIds = [...new Set(staffIds)];
    if (uniqueIds.length === 0) {
      return new Map();
    }
    const staff = await this.staffModel.find({ _id: { $in: uniqueIds } }).exec();
    return new Map(staff.map((s) => [s._id.toString(), `${s.firstName} ${s.lastName}`.trim()]));
  }

  /** `id -> name` for a batch of branch ids — same shape/purpose as resolveStaffNames. */
  async resolveBranchNames(branchIds: string[]): Promise<Map<string, string>> {
    const uniqueIds = [...new Set(branchIds)];
    if (uniqueIds.length === 0) {
      return new Map();
    }
    const branches = await this.branchModel.find({ _id: { $in: uniqueIds } }).exec();
    return new Map(branches.map((b) => [b._id.toString(), b.name]));
  }

  /**
   * `customerId -> the (approved) group they're currently a member of` —
   * there's no field on Customer itself for this (group membership lives on
   * GroupMembership, a separate collection owned by the groups module — see
   * the cross-module raw-schema import at the top of this file). At most one
   * *active* (leftAt: null) membership per customer by construction, so
   * last-write-wins in the returned map is never actually ambiguous.
   */
  async resolveGroupNames(customerIds: string[]): Promise<Map<string, string>> {
    const uniqueIds = [...new Set(customerIds)];
    if (uniqueIds.length === 0) {
      return new Map();
    }
    const memberships = await this.groupMembershipModel
      .find({ customerId: { $in: uniqueIds.map((id) => new Types.ObjectId(id)) }, leftAt: null })
      .exec();
    if (memberships.length === 0) {
      return new Map();
    }
    const groupIds = [...new Set(memberships.map((m) => m.groupId.toString()))];
    const groups = await this.groupModel.find({ _id: { $in: groupIds } }).exec();
    const groupNameById = new Map(groups.map((g) => [g._id.toString(), g.name]));

    const result = new Map<string, string>();
    memberships.forEach((membership) => {
      const groupName = groupNameById.get(membership.groupId.toString());
      if (groupName) {
        result.set(membership.customerId.toString(), groupName);
      }
    });
    return result;
  }

  /**
   * Presence-only flags — whether a biometric/ID document/NIN has been
   * captured at all, never the plaintext/decrypted value itself, so this
   * doesn't need `readAndAudit`'s KYC_DATA_READ trail (nothing sensitive is
   * actually being read). Same view permission as findByIdForActor — lets
   * the UI show "uploaded" state + an eye icon to whoever can already see
   * this customer, not just Admin/Approver.
   */
  async getKycCaptureStatus(customerId: string, viewer: CustomerViewerContext): Promise<{
    biometricCaptured: boolean;
    idDocumentCaptured: boolean;
    idDocumentType: IdDocumentType | null;
    ninRecorded: boolean;
    ninVerified: boolean;
    bvnVerifiedAt: Date | null;
  }> {
    await this.findByIdForActor(customerId, viewer);
    const kyc = await this.getKycRecordOrThrow(customerId);
    return {
      biometricCaptured: Boolean(kyc.biometricImageKey),
      idDocumentCaptured: Boolean(kyc.idDocumentImageKey),
      idDocumentType: kyc.idDocumentType,
      ninRecorded: Boolean(kyc.nin),
      ninVerified: Boolean(kyc.ninVerifiedAt),
      bvnVerifiedAt: kyc.bvnVerifiedAt,
    };
  }

  /**
   * `filter.branchId`/`filter.createdById` are only honored for
   * ADMIN/SUPERADMIN/APPROVER — a MANAGER's effective scope is always their
   * own branch and a MARKETER's is always their own records, regardless of
   * what they pass, same "the capability lets you call the route, this
   * enforces the row-level scope" split as `assertCanView` above.
   */
  async findAllForActor(filter: FindCustomersFilter, viewer: CustomerViewerContext): Promise<CustomerDocument[]> {
    const query: Record<string, unknown> = {};

    if (viewer.role === StaffRole.MANAGER) {
      if (!viewer.branchId) {
        return [];
      }
      query.branchId = new Types.ObjectId(viewer.branchId);
      // A DRAFT customer is still mid-onboarding — the marketer hasn't
      // submitted it yet, so it has no WorkflowRequest and nothing here is
      // actually the Manager's to review. Excluding it is what stops an
      // unfinished record from reading as "awaiting review" the moment its
      // BVN gets verified. See CustomerStatus.DRAFT's own doc comment.
      query.status = { $ne: CustomerStatus.DRAFT };
    } else if (viewer.role !== StaffRole.ADMIN && viewer.role !== StaffRole.SUPERADMIN && viewer.role !== StaffRole.APPROVER) {
      // MARKETER (or any future non-privileged role) — locked to their own
      // records, DRAFT included: they need to see their own in-progress
      // onboarding to actually finish and submit it.
      query.createdBy = new Types.ObjectId(viewer.staffId);
    } else {
      // ADMIN/SUPERADMIN/APPROVER — same DRAFT exclusion as MANAGER; a
      // system-wide oversight view still shouldn't surface every marketer's
      // unfinished drafts as if they were on record for review.
      query.status = { $ne: CustomerStatus.DRAFT };
      if (filter.branchId) {
        query.branchId = new Types.ObjectId(filter.branchId);
      }
      if (filter.createdById) {
        query.createdBy = new Types.ObjectId(filter.createdById);
      }
    }

    return this.customerModel.find(query).sort({ createdAt: -1 }).exec();
  }

  // ---------------------------------------------------------------------------
  // Disable / enable — Admin/SuperAdmin/Approver only, independent of the
  // onboarding workflow (same pattern as Staff.status, see identity/staff.service.ts)
  // ---------------------------------------------------------------------------

  async disable(customerId: string, disabledBy: string, reason: string): Promise<CustomerDocument> {
    const customer = await this.findActiveDraft(customerId);
    if (customer.status !== CustomerStatus.ACTIVE) {
      throw new BadRequestException(`Customer ${customerId} is not active — cannot disable`);
    }

    const previousStatus = customer.status;
    customer.status = CustomerStatus.DISABLED;
    customer.disabledReason = reason;
    customer.disabledBy = new Types.ObjectId(disabledBy);
    customer.disabledAt = new Date();
    await customer.save();

    await this.auditService.record({
      actorId: disabledBy,
      action: 'CUSTOMER_DISABLED',
      entityType: 'CUSTOMER',
      entityId: customerId,
      before: { status: previousStatus },
      after: { status: CustomerStatus.DISABLED },
      metadata: { reason },
    });

    return customer;
  }

  async enable(customerId: string, enabledBy: string): Promise<CustomerDocument> {
    const customer = await this.findActiveDraft(customerId);
    if (customer.status !== CustomerStatus.DISABLED) {
      throw new BadRequestException(`Customer ${customerId} is not disabled`);
    }

    customer.status = CustomerStatus.ACTIVE;
    customer.disabledReason = null;
    customer.disabledBy = null;
    customer.disabledAt = null;
    await customer.save();

    await this.auditService.record({
      actorId: enabledBy,
      action: 'CUSTOMER_ENABLED',
      entityType: 'CUSTOMER',
      entityId: customerId,
      after: { status: CustomerStatus.ACTIVE },
    });

    return customer;
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

  /** Whatever CustomerService.buildMismatchFlags recorded at BVN confirm time — [] if nothing was submitted to compare, or nothing mismatched. */
  async getMismatchFlags(customerId: string, actorId: string): Promise<MismatchFlag[]> {
    const kyc = await this.getKycRecordOrThrow(customerId);
    return this.readAndAudit(customerId, actorId, ['mismatchFlags'], () => kyc.mismatchFlags);
  }

  /**
   * Only the customer's creator may resolve a flagged BVN-submission
   * mismatch (see buildMismatchFlags) — picks between the provider's
   * resolved identity (default, already on the Customer record — no
   * change needed, no reason required) and what was originally submitted
   * (requires `reason`, and overwrites firstName/lastName/phoneNumber on
   * the Customer). Every currently-unresolved flag gets the same
   * resolution + timestamp + actor; recomputeKycStatus runs afterward so
   * kycStatus clears back to VERIFIED once nothing is left unresolved —
   * the flags themselves stay on the record either way, as a permanent
   * audit trail.
   */
  async resolveIdentityMismatch(
    customerId: string,
    resolvedBy: string,
    input: ResolveIdentityMismatchInput,
  ): Promise<{ customer: CustomerDocument; mismatchFlags: MismatchFlag[] }> {
    const customer = await this.findActiveDraft(customerId);
    this.assertIsCreator(customer, resolvedBy);

    const kyc = await this.getKycRecordOrThrow(customerId);
    const unresolvedFlags = kyc.mismatchFlags.filter((flag) => !flag.resolvedAt);
    if (unresolvedFlags.length === 0) {
      throw new ConflictException(`Customer ${customerId} has no unresolved identity mismatch to resolve`);
    }

    if (input.useSubmittedValues) {
      if (!input.reason || input.reason.trim().length < 3) {
        throw new BadRequestException("A reason is required to use the submitted details over the provider's");
      }

      if (unresolvedFlags.some((flag) => flag.field === 'fullName')) {
        if (!input.fullName?.trim()) {
          throw new BadRequestException('fullName is required to resolve the flagged name mismatch');
        }
        const { firstName, lastName } = splitFullName(input.fullName);
        customer.firstName = firstName;
        customer.lastName = lastName;
      }

      if (unresolvedFlags.some((flag) => flag.field === 'phoneNumber')) {
        if (!input.phoneNumber?.trim()) {
          throw new BadRequestException('phoneNumber is required to resolve the flagged phone mismatch');
        }
        const nextPhoneNumber = input.phoneNumber.trim();
        if (nextPhoneNumber !== customer.phoneNumber) {
          await this.assertPhoneNumberAvailable(nextPhoneNumber, customerId);
        }
        customer.phoneNumber = nextPhoneNumber;
      }

      await customer.save();
    }

    const now = new Date();
    const resolution = input.useSubmittedValues ? 'USED_SUBMITTED_VALUE' : 'KEPT_PROVIDER_VALUE';
    for (const flag of kyc.mismatchFlags) {
      if (!flag.resolvedAt) {
        flag.resolvedAt = now;
        flag.resolvedBy = new Types.ObjectId(resolvedBy);
        flag.resolution = resolution;
        flag.reason = input.useSubmittedValues ? input.reason!.trim() : null;
      }
    }
    kyc.markModified('mismatchFlags');
    await kyc.save();

    await this.auditService.record({
      actorId: resolvedBy,
      action: 'CUSTOMER_IDENTITY_MISMATCH_RESOLVED',
      entityType: 'CUSTOMER',
      entityId: customerId,
      after: {
        resolution,
        firstName: customer.firstName,
        lastName: customer.lastName,
        phoneNumber: customer.phoneNumber,
      },
      metadata: { reason: input.useSubmittedValues ? input.reason : null },
    });

    await this.recomputeKycStatus(customerId);

    return { customer, mismatchFlags: kyc.mismatchFlags };
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

  async getIdDocumentSignedUrl(
    customerId: string,
    actorId: string,
    expiresInSeconds?: number,
  ): Promise<string | null> {
    const kyc = await this.getKycRecordOrThrow(customerId);
    if (!kyc.idDocumentImageKey) {
      return null;
    }
    const key = kyc.idDocumentImageKey;
    return this.readAndAudit(customerId, actorId, ['idDocumentImage'], () =>
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

  /**
   * A reviewer/approver re-checking a submission — live re-verifies the
   * stored BVN against the provider (same call as
   * recordBvnDirectVerifyForContext, context REVIEW_RECHECK) and hands back
   * both the fresh provider details and what's currently on the Customer
   * record, so the caller can compare them side by side before deciding.
   * Purely informational — never mutates the Customer itself (only the
   * KycRecord's own bvnVerifiedAt/lastVerifiedForContext bookkeeping, same
   * as any other directVerify recheck).
   */
  async reviewBvnComparison(
    customerId: string,
    actorId: string,
  ): Promise<{
    provider: BvnDetails;
    onRecord: { firstName: string; lastName: string; phoneNumber: string };
  }> {
    const customer = await this.findActiveDraft(customerId);
    const provider = await this.recordBvnDirectVerifyForContext(
      customerId,
      VerificationContext.REVIEW_RECHECK,
      actorId,
    );
    return {
      provider,
      onRecord: {
        firstName: customer.firstName,
        lastName: customer.lastName,
        phoneNumber: customer.phoneNumber,
      },
    };
  }
}
