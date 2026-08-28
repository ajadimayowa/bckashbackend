import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import * as bcrypt from 'bcryptjs';
import { Model, Types } from 'mongoose';

import {
  Gender,
  IdentificationType,
  ModuleName,
  StaffRole,
  StaffStatus,
  StaffUserType,
} from '../../common/enums/identity.enums';
import { WorkflowEntityType } from '../../common/enums/workflow.enums';
import {
  staffDocumentUrlsFromUpload,
  type StaffDocumentFiles,
} from '../../common/upload/upload.config';
import { AuditService } from '../../platform/audit/audit.service';
import { EncryptionService } from '../../platform/encryption/encryption.service';
import {
  BVN_VERIFICATION_ADAPTER,
  BvnDetails,
  BvnVerificationAdapter,
} from '../../platform/integrations/bvn/interfaces/bvn-verification-adapter.interface';
import { approveCapability } from '../../platform/rbac/constants/capabilities';
import {
  WORKFLOW_APPROVED_EVENT,
  WorkflowApprovedEvent,
} from '../../platform/workflow-engine/events/workflow-engine.events';
import { WorkflowEngineService } from '../../platform/workflow-engine/workflow-engine.service';
// Cross-module read only — the raw Branch/Customer/Group/Loan models, not
// their own services/modules. See PHASE_3_NOTES.md ("cross-module existence checks").
import { Branch, BranchDocument } from '../branches/schemas/branch.schema';
import { Customer, CustomerDocument } from '../customers/schemas/customer.schema';
import { GroupStatus } from '../../common/enums/group.enums';
import { Group, GroupDocument } from '../groups/schemas/group.schema';
import { Loan, LoanDocument } from '../loans/schemas/loan.schema';
import { DepartmentsService } from './departments.service';
import { BvnPreviewResponseDto } from './dto/bvn-preview-response.dto';
import { CreateStaffDirectDto } from './dto/create-staff-direct.dto';
import { InitiateStaffOnboardingDto } from './dto/initiate-staff-onboarding.dto';
import { StaffActivityEntryDto } from './dto/staff-activity-entry.dto';
import { StaffPerformanceSummaryDto } from './dto/staff-performance-summary.dto';
import { UpdateOwnStaffProfileDto } from './dto/update-own-staff-profile.dto';
import { UpdateStaffComplianceDto } from './dto/update-staff-compliance.dto';
import { UpdateStaffProfileDto } from './dto/update-staff-profile.dto';
import {
  STAFF_CREATED_EVENT,
  STAFF_DISABLED_EVENT,
  STAFF_PASSWORD_CHANGED_EVENT,
  StaffCreatedEvent,
  StaffDisabledEvent,
  StaffPasswordChangedEvent,
} from './events/staff.events';
import { RefreshTokenService } from './refresh-token.service';
import { Staff, StaffDocument } from './schemas/staff.schema';
import { UnitsService } from './units.service';
import { generateTemporaryPassword } from './utils/generate-temporary-password.util';
import { WorkflowRequestDocument } from '../../platform/workflow-engine/schemas/workflow-request.schema';

const BCRYPT_SALT_ROUNDS = 12;

interface StaffOnboardingContactPerson {
  name: string;
  relationship: string;
  phoneNumber: string;
  address: string;
}

interface StaffOnboardingResidentialAddress {
  state: string;
  city: string;
  street: string;
}

/** Dates travel as ISO strings, not `Date` — see this file's own comment on `startDate`/`kyc.dateOfBirth` below. */
interface StaffOnboardingKyc {
  dateOfBirth: string;
  gender: Gender;
  idType: IdentificationType;
  idNumber: string;
}

/**
 * No password field — a plaintext password never sits in a WorkflowRequest
 * document waiting for review (was already true before; this phase's own
 * change removes it from the *input* side entirely, since the password is
 * now system-generated fresh at `handleWorkflowApproved` time, not chosen
 * by whoever initiates onboarding). See generate-temporary-password.util.ts.
 *
 * `bvnEncrypted` is pre-encrypted at `initiateOnboarding` time (never the
 * raw digits) — the workflow engine's payload is opaque, but a plaintext
 * BVN still shouldn't sit in the `workflow_requests` collection unencrypted
 * while a request awaits approval. `startDate`/`kyc.dateOfBirth` are plain
 * ISO date strings rather than `Date` instances — this payload round-trips
 * through the workflow engine's `Record<string, unknown>` (Mongoose Mixed)
 * storage, and converting to `Date` only happens once, right at
 * `handleWorkflowApproved`'s final `staffModel.create()` call.
 */
interface StaffOnboardingPayload {
  role: StaffRole;
  firstName: string;
  lastName: string;
  email: string;
  phoneNumber: string;
  userType: StaffUserType;
  departmentId: string;
  unitId: string;
  branchId: string;
  moduleAccess: ModuleName[];
  startDate: string;
  bvnEncrypted: string | null;
  residentialAddress: StaffOnboardingResidentialAddress;
  kyc: StaffOnboardingKyc;
  nextOfKin: StaffOnboardingContactPerson;
  reference: StaffOnboardingContactPerson;
  /** Already-saved-to-disk public URLs (see common/upload/upload.config.ts) — files are written synchronously at request time regardless of workflow timing. */
  passportPhotoUrl: string | null;
  idDocumentUrl: string | null;
}

@Injectable()
export class StaffService implements OnModuleInit {
  constructor(
    @InjectModel(Staff.name) private readonly staffModel: Model<StaffDocument>,
    @InjectModel(Branch.name) private readonly branchModel: Model<BranchDocument>,
    @InjectModel(Customer.name) private readonly customerModel: Model<CustomerDocument>,
    @InjectModel(Group.name) private readonly groupModel: Model<GroupDocument>,
    @InjectModel(Loan.name) private readonly loanModel: Model<LoanDocument>,
    private readonly departmentsService: DepartmentsService,
    private readonly unitsService: UnitsService,
    private readonly workflowEngineService: WorkflowEngineService,
    private readonly auditService: AuditService,
    private readonly refreshTokenService: RefreshTokenService,
    @Inject(BVN_VERIFICATION_ADAPTER) private readonly bvnAdapter: BvnVerificationAdapter,
    private readonly encryptionService: EncryptionService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async onModuleInit(): Promise<void> {
    // Single step, held by Admin/Approver — matches the brief's "Marketers are
    // onboarded by Branch Managers, subject to Admin/Approver approval."
    // Capability is `workflow:approve:STAFF` (Phase 2's established naming
    // convention), not the literal "staff:approve" string from this phase's
    // prompt — see PHASE_3_NOTES.md.
    await this.workflowEngineService.registerChainConfig({
      entityType: WorkflowEntityType.STAFF,
      action: 'CREATE',
      restartOnReturn: true,
      steps: [{ order: 0, requiredCapability: approveCapability(WorkflowEntityType.STAFF) }],
    });

    // Initiator/Authorizer RBAC — the one entity-type-specific rule beyond
    // the system-wide "Initiator initiates, Authorizer approves" gate
    // (RbacService.filterCapabilitiesByUserType): the approver must not just
    // BE an Authorizer, they must hold the SAME role as whoever initiated
    // this particular staff proposal (e.g. a SUPERADMIN-initiated proposal
    // needs a SUPERADMIN Authorizer; an ADMIN-initiated one needs an ADMIN
    // Authorizer). Runs as a PreApprovalValidator (only at the final —
    // here, only — step) rather than a capability, since "same role as
    // THIS SPECIFIC request's initiator" isn't expressible as a static,
    // role-seeded capability grant the way the rest of RBAC is.
    //
    // MANAGER doesn't otherwise hold `workflow:approve:STAFF` (only
    // `workflow:review:STAFF` — see default-role-capabilities.ts) — granted
    // there specifically so a MANAGER-initiated proposal has an Authorizer
    // pool to draw from at all; this validator is what keeps that grant
    // scoped to "only ever approves another Manager's own proposal," never
    // anyone else's.
    this.workflowEngineService.registerPreApprovalValidator(
      WorkflowEntityType.STAFF,
      'CREATE',
      async (request, actor) => {
        // Defensive — `initiatedBy` is always a real Staff _id in production
        // (see WorkflowEngineService.initiate), but guards against a
        // CastError if it's ever anything else.
        if (!Types.ObjectId.isValid(request.initiatedBy)) {
          return;
        }
        const initiator = await this.staffModel
          .findById(request.initiatedBy)
          .select('role')
          .lean()
          .exec();
        if (initiator && actor.role !== initiator.role) {
          throw new ForbiddenException(
            `Only a ${initiator.role} may approve a staff proposal initiated by a ${initiator.role}`,
          );
        }
      },
    );
  }

  /**
   * MARKETER's userType is non-negotiable (Initiator, always — see
   * StaffUserType's own doc comment) regardless of what a caller submits;
   * every other onboardable role must explicitly be Initiator or
   * Authorizer — `Reviewer` (the third, legacy StaffUserType value) is no
   * longer an assignable choice for a *new* staff record, only ever seen on
   * one created before this rule existed. Shared by initiateOnboarding and
   * createDirect — the one place both actually persist a userType.
   */
  private resolveUserType(role: StaffRole, requestedUserType: StaffUserType): StaffUserType {
    if (role === StaffRole.MARKETER) {
      return StaffUserType.INITIATOR;
    }
    if (requestedUserType !== StaffUserType.INITIATOR && requestedUserType !== StaffUserType.AUTHORIZER) {
      throw new BadRequestException(
        `userType must be ${StaffUserType.INITIATOR} or ${StaffUserType.AUTHORIZER} for role ${role} (got ${requestedUserType})`,
      );
    }
    return requestedUserType;
  }

  private async validateOrgReferences(
    departmentId: string,
    unitId: string,
    branchId: string,
  ): Promise<void> {
    await this.departmentsService.assertExists(departmentId);
    await this.unitsService.assertBelongsToDepartment(unitId, departmentId);
    const branch = await this.branchModel.findById(branchId).lean().exec();
    if (!branch) {
      throw new BadRequestException(`Branch ${branchId} does not exist`);
    }
    if (!branch.active) {
      throw new BadRequestException(`Branch ${branchId} is not active — staff cannot be assigned to it`);
    }
  }

  private async assertEmailAndPhoneAvailable(email: string, phoneNumber: string): Promise<void> {
    const existing = await this.staffModel
      .findOne({ $or: [{ email: email.toLowerCase() }, { phoneNumber }] })
      .lean()
      .exec();
    if (existing) {
      throw new ConflictException(
        existing.email === email.toLowerCase()
          ? `A staff member with email ${email} already exists`
          : `A staff member with phone number ${phoneNumber} already exists`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Onboarding (workflow-mediated — any role in ONBOARDABLE_STAFF_ROLES,
  // i.e. every real role except SUPERADMIN; see InitiateStaffOnboardingDto)
  // ---------------------------------------------------------------------------

  /**
   * Restricting who may propose an ADMIN/APPROVER account — a Manager (who
   * also holds initiateCapability(STAFF), for onboarding Marketers) should
   * never be able to propose a peer or superior role. Checked explicitly
   * (not just hidden client-side) since the capability model alone doesn't
   * distinguish *which* role is being proposed, only that STAFF onboarding
   * in general is allowed. Shared by initiateOnboarding and
   * resubmitOnboarding — an edited resubmission must satisfy this rule
   * against the (possibly still-just-as-restricted) role all over again,
   * using whoever is doing the resubmitting's CURRENT role, not whichever
   * role them (or someone else) held the first time around.
   */
  private assertCanProposeRole(role: StaffRole, proposerRole: StaffRole): void {
    if (
      (role === StaffRole.ADMIN || role === StaffRole.APPROVER) &&
      proposerRole !== StaffRole.ADMIN &&
      proposerRole !== StaffRole.SUPERADMIN
    ) {
      throw new ForbiddenException(`Only an Admin or SuperAdmin may onboard a staff member as ${role}`);
    }
  }

  /**
   * Shared by initiateOnboarding and resubmitOnboarding — everything about
   * turning a validated DTO into the opaque payload the workflow engine
   * stores. `existingUrls` is only ever passed by resubmitOnboarding (the
   * rejected proposal's own last-known photo/id document, so re-submitting
   * without picking a new file keeps what was already on file rather than
   * silently clearing it — see staffDocumentUrlsFromUpload's own doc
   * comment: it returns null for whichever file wasn't (re-)uploaded this
   * call).
   */
  private buildOnboardingPayload(
    dto: InitiateStaffOnboardingDto,
    files: StaffDocumentFiles | undefined,
    existingUrls: { passportPhotoUrl: string | null; idDocumentUrl: string | null } = {
      passportPhotoUrl: null,
      idDocumentUrl: null,
    },
  ): StaffOnboardingPayload {
    const uploaded = staffDocumentUrlsFromUpload(files);

    return {
      role: dto.role,
      firstName: dto.firstName,
      lastName: dto.lastName,
      email: dto.email.toLowerCase(),
      phoneNumber: dto.phoneNumber,
      userType: this.resolveUserType(dto.role, dto.userType),
      departmentId: dto.departmentId,
      unitId: dto.unitId,
      branchId: dto.branchId,
      moduleAccess: dto.moduleAccess,
      startDate: dto.startDate,
      bvnEncrypted: dto.bvn ? this.encryptionService.encrypt(dto.bvn) : null,
      residentialAddress: {
        state: dto.residentialAddress.state,
        city: dto.residentialAddress.city,
        street: dto.residentialAddress.street,
      },
      kyc: {
        dateOfBirth: dto.kyc.dateOfBirth,
        gender: dto.kyc.gender,
        idType: dto.kyc.idType,
        idNumber: dto.kyc.idNumber,
      },
      nextOfKin: {
        name: dto.nextOfKin.name,
        relationship: dto.nextOfKin.relationship,
        phoneNumber: dto.nextOfKin.phoneNumber,
        address: dto.nextOfKin.address,
      },
      reference: {
        name: dto.reference.name,
        relationship: dto.reference.relationship,
        phoneNumber: dto.reference.phoneNumber,
        address: dto.reference.address,
      },
      passportPhotoUrl: uploaded.passportPhotoUrl ?? existingUrls.passportPhotoUrl,
      idDocumentUrl: uploaded.idDocumentUrl ?? existingUrls.idDocumentUrl,
    };
  }

  async initiateOnboarding(
    dto: InitiateStaffOnboardingDto,
    initiatedBy: string,
    initiatedByRole: StaffRole,
    files?: StaffDocumentFiles,
  ): Promise<WorkflowRequestDocument> {
    this.assertCanProposeRole(dto.role, initiatedByRole);

    await this.validateOrgReferences(dto.departmentId, dto.unitId, dto.branchId);
    await this.assertEmailAndPhoneAvailable(dto.email, dto.phoneNumber);

    const payload = this.buildOnboardingPayload(dto, files);

    return this.workflowEngineService.initiate({
      entityType: WorkflowEntityType.STAFF,
      action: 'CREATE',
      // The engine's payload is intentionally opaque (Record<string, unknown>)
      // — it never interprets domain payload shape, only stores/versions it.
      payload: payload as unknown as Record<string, unknown>,
      initiatedBy,
      branchId: dto.branchId,
    });
  }

  /**
   * Edit-and-resubmit for a REJECTED (or RETURNED_TO_MAKER) staff onboarding
   * proposal — the frontend's "Edit & Resubmit" action in the Rejected tab.
   * Nothing about the underlying request's mechanics differs from a fresh
   * `initiateOnboarding` call (same validation, same payload shape); the
   * only real difference is which WorkflowEngineService method finishes the
   * job — `resubmit` (restarts the existing request's chain) instead of
   * `initiate` (creates a new one) — and that a file left un-attached this
   * time falls back to whatever the rejected proposal already had on file
   * (see buildOnboardingPayload's own doc comment), rather than requiring
   * the photo/ID to be re-uploaded on every edit.
   *
   * `WorkflowEngineService.resubmit` itself enforces "only the original
   * initiator" and "only REJECTED/RETURNED_TO_MAKER" — not re-checked here,
   * so those failures surface with that method's own error messages.
   */
  async resubmitOnboarding(
    workflowRequestId: string,
    dto: InitiateStaffOnboardingDto,
    actorId: string,
    actorRole: StaffRole,
    files?: StaffDocumentFiles,
  ): Promise<WorkflowRequestDocument> {
    const request = await this.workflowEngineService.getById(workflowRequestId);
    if (
      (request.entityType as WorkflowEntityType) !== WorkflowEntityType.STAFF ||
      request.action !== 'CREATE'
    ) {
      throw new BadRequestException(
        `WorkflowRequest ${workflowRequestId} is not a staff onboarding request`,
      );
    }

    this.assertCanProposeRole(dto.role, actorRole);

    await this.validateOrgReferences(dto.departmentId, dto.unitId, dto.branchId);
    await this.assertEmailAndPhoneAvailable(dto.email, dto.phoneNumber);

    const latestPayload = request.payloadHistory[request.payloadHistory.length - 1]
      ?.payload as unknown as StaffOnboardingPayload | undefined;
    const payload = this.buildOnboardingPayload(dto, files, {
      passportPhotoUrl: latestPayload?.passportPhotoUrl ?? null,
      idDocumentUrl: latestPayload?.idDocumentUrl ?? null,
    });

    return this.workflowEngineService.resubmit({
      workflowRequestId,
      actorId,
      newPayload: payload as unknown as Record<string, unknown>,
    });
  }

  @OnEvent(WORKFLOW_APPROVED_EVENT)
  async handleWorkflowApproved(event: WorkflowApprovedEvent): Promise<void> {
    // event.entityType is an opaque string as far as the engine is concerned
    // (see PHASE_2_NOTES.md) — cast to compare against our known constant.
    if (
      (event.entityType as WorkflowEntityType) !== WorkflowEntityType.STAFF ||
      event.action !== 'CREATE'
    ) {
      return;
    }

    const payload = event.payload as unknown as StaffOnboardingPayload;

    // Generated fresh here, not carried through the workflow payload — see
    // this file's own StaffOnboardingPayload comment and
    // generate-temporary-password.util.ts.
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await bcrypt.hash(temporaryPassword, BCRYPT_SALT_ROUNDS);

    const created = await this.staffModel.create({
      firstName: payload.firstName,
      lastName: payload.lastName,
      email: payload.email,
      phoneNumber: payload.phoneNumber,
      passwordHash,
      role: payload.role,
      userType: payload.userType,
      // Explicit Types.ObjectId casts — a plain string does not reliably
      // cast against a Types.ObjectId-typed schema path in this project's
      // Mongoose setup, including on .create() (empirically confirmed while
      // building DepartmentsService/UnitsService.countStaff* — see their
      // own doc comments; same recurring bug class documented throughout
      // this codebase, just newly found on a *write* path here).
      departmentId: new Types.ObjectId(payload.departmentId),
      unitId: new Types.ObjectId(payload.unitId),
      branchId: new Types.ObjectId(payload.branchId),
      moduleAccess: payload.moduleAccess,
      status: StaffStatus.ACTIVE,
      mustChangePassword: true,
      startDate: new Date(payload.startDate),
      bvnEncrypted: payload.bvnEncrypted,
      residentialAddress: payload.residentialAddress,
      kyc: { ...payload.kyc, dateOfBirth: new Date(payload.kyc.dateOfBirth) },
      nextOfKin: payload.nextOfKin,
      reference: payload.reference,
      passportPhotoUrl: payload.passportPhotoUrl,
      idDocumentUrl: payload.idDocumentUrl,
    });

    await this.workflowEngineService.linkEntity(event.workflowRequestId, created._id.toString());

    await this.auditService.record({
      actorId: event.initiatedBy,
      action: 'STAFF_CREATED_VIA_ONBOARDING',
      entityType: 'STAFF',
      entityId: created._id.toString(),
      after: { email: created.email, role: created.role, branchId: payload.branchId },
      metadata: { workflowRequestId: event.workflowRequestId },
    });

    this.emitStaffCreated(created, temporaryPassword);
  }

  /** Shared by both creation paths — see STAFF_CREATED_EVENT's own doc comment. */
  private emitStaffCreated(staff: StaffDocument, temporaryPassword: string): void {
    const event: StaffCreatedEvent = {
      staffId: staff._id.toString(),
      firstName: staff.firstName,
      lastName: staff.lastName,
      email: staff.email,
      phoneNumber: staff.phoneNumber,
      role: staff.role,
      userType: staff.userType,
      departmentId: staff.departmentId.toString(),
      branchId: staff.branchId.toString(),
      temporaryPassword,
    };
    this.eventEmitter.emit(STAFF_CREATED_EVENT, event);
  }

  // ---------------------------------------------------------------------------
  // Direct creation (SuperAdmin only — MANAGER/ADMIN/APPROVER, see PHASE_3_NOTES.md)
  // ---------------------------------------------------------------------------

  async createDirect(
    dto: CreateStaffDirectDto,
    createdBy: string,
    files?: StaffDocumentFiles,
  ): Promise<StaffDocument> {
    await this.validateOrgReferences(dto.departmentId, dto.unitId, dto.branchId);
    await this.assertEmailAndPhoneAvailable(dto.email, dto.phoneNumber);

    // System-generated, not operator-typed — see this file's
    // StaffOnboardingPayload comment and generate-temporary-password.util.ts.
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await bcrypt.hash(temporaryPassword, BCRYPT_SALT_ROUNDS);
    const { passportPhotoUrl, idDocumentUrl } = staffDocumentUrlsFromUpload(files);

    const created = await this.staffModel.create({
      firstName: dto.firstName,
      lastName: dto.lastName,
      email: dto.email.toLowerCase(),
      phoneNumber: dto.phoneNumber,
      passwordHash,
      role: dto.role,
      userType: this.resolveUserType(dto.role, dto.userType),
      // Explicit Types.ObjectId casts — see handleWorkflowApproved's own
      // comment on the same fields above.
      departmentId: new Types.ObjectId(dto.departmentId),
      unitId: new Types.ObjectId(dto.unitId),
      branchId: new Types.ObjectId(dto.branchId),
      moduleAccess: dto.moduleAccess,
      status: StaffStatus.ACTIVE,
      mustChangePassword: true,
      startDate: new Date(dto.startDate),
      bvnEncrypted: dto.bvn ? this.encryptionService.encrypt(dto.bvn) : null,
      residentialAddress: {
        state: dto.residentialAddress.state,
        city: dto.residentialAddress.city,
        street: dto.residentialAddress.street,
      },
      kyc: {
        dateOfBirth: new Date(dto.kyc.dateOfBirth),
        gender: dto.kyc.gender,
        idType: dto.kyc.idType,
        idNumber: dto.kyc.idNumber,
      },
      nextOfKin: {
        name: dto.nextOfKin.name,
        relationship: dto.nextOfKin.relationship,
        phoneNumber: dto.nextOfKin.phoneNumber,
        address: dto.nextOfKin.address,
      },
      reference: {
        name: dto.reference.name,
        relationship: dto.reference.relationship,
        phoneNumber: dto.reference.phoneNumber,
        address: dto.reference.address,
      },
      passportPhotoUrl,
      idDocumentUrl,
    });

    await this.auditService.record({
      actorId: createdBy,
      action: 'STAFF_CREATED_DIRECT',
      entityType: 'STAFF',
      entityId: created._id.toString(),
      after: { email: created.email, role: created.role, branchId: dto.branchId },
    });

    this.emitStaffCreated(created, temporaryPassword);

    return created;
  }

  /**
   * PATCH /staff/:id/documents — replace whichever of passportPhoto/
   * idDocument was actually sent (either, both, neither is a no-op). The
   * previous file on disk is left alone; only the stored URL moves on to
   * the new one.
   */
  async updateDocuments(
    staffId: string,
    files: StaffDocumentFiles | undefined,
    updatedBy: string,
  ): Promise<StaffDocument> {
    const staff = await this.findById(staffId);
    const { passportPhotoUrl, idDocumentUrl } = staffDocumentUrlsFromUpload(files);

    if (!passportPhotoUrl && !idDocumentUrl) {
      return staff;
    }

    const before = {
      passportPhotoUrl: staff.passportPhotoUrl,
      idDocumentUrl: staff.idDocumentUrl,
    };

    if (passportPhotoUrl) {
      staff.passportPhotoUrl = passportPhotoUrl;
    }
    if (idDocumentUrl) {
      staff.idDocumentUrl = idDocumentUrl;
    }
    await staff.save();

    await this.auditService.record({
      actorId: updatedBy,
      action: 'STAFF_DOCUMENTS_UPDATED',
      entityType: 'STAFF',
      entityId: staffId,
      before,
      after: { passportPhotoUrl: staff.passportPhotoUrl, idDocumentUrl: staff.idDocumentUrl },
    });

    return staff;
  }

  /**
   * PATCH /staff/me — self-service update of the small set of fields a
   * staff member reasonably owns about themselves. Everything org-managed
   * (role/department/unit/branch/email/moduleAccess/status) is untouched by
   * this method on purpose; those still go through the capability-gated
   * admin endpoints.
   */
  async updateOwnProfile(staffId: string, dto: UpdateOwnStaffProfileDto): Promise<StaffDocument> {
    const staff = await this.findById(staffId);

    const before = {
      phoneNumber: staff.phoneNumber,
      residentialAddress: staff.residentialAddress,
      nextOfKin: staff.nextOfKin,
      reference: staff.reference,
    };

    if (dto.phoneNumber !== undefined && dto.phoneNumber !== staff.phoneNumber) {
      const existing = await this.staffModel
        .findOne({ phoneNumber: dto.phoneNumber, _id: { $ne: staff._id } })
        .lean()
        .exec();
      if (existing) {
        throw new ConflictException(`A staff member with phone number ${dto.phoneNumber} already exists`);
      }
      staff.phoneNumber = dto.phoneNumber;
    }
    if (dto.residentialAddress !== undefined) {
      staff.residentialAddress = dto.residentialAddress;
    }
    if (dto.nextOfKin !== undefined) {
      staff.nextOfKin = dto.nextOfKin;
    }
    if (dto.reference !== undefined) {
      staff.reference = dto.reference;
    }
    await staff.save();

    await this.auditService.record({
      actorId: staffId,
      action: 'STAFF_OWN_PROFILE_UPDATED',
      entityType: 'STAFF',
      entityId: staffId,
      before,
      after: {
        phoneNumber: staff.phoneNumber,
        residentialAddress: staff.residentialAddress,
        nextOfKin: staff.nextOfKin,
        reference: staff.reference,
      },
    });

    return staff;
  }

  /**
   * PATCH /staff/:id — an org:manage admin (ADMIN/SUPERADMIN) correcting or
   * filling in another staff member's record. Deliberately can't touch
   * `status`/BVN-verification/compliance-verification/passportPhoto|
   * idDocument — see UpdateStaffProfileDto's own doc comment for why each
   * of those stays on its own dedicated endpoint instead.
   */
  async updateProfile(staffId: string, dto: UpdateStaffProfileDto, updatedBy: string): Promise<StaffDocument> {
    const staff = await this.findById(staffId);

    // The seeded SuperAdmin's record is never touched through this generic
    // route at all — not just `role` — and no other staff member can be
    // promoted into SUPERADMIN through it either. Mirrors
    // CreateStaffDirectDto's own "never SUPERADMIN" restriction at creation
    // time; a role change that sensitive deserves its own deliberate flow,
    // not a side effect of a general profile edit.
    if (staff.role === StaffRole.SUPERADMIN || dto.role === StaffRole.SUPERADMIN) {
      throw new BadRequestException(
        'SUPERADMIN accounts cannot be edited, and SUPERADMIN cannot be assigned, through this endpoint',
      );
    }

    if (dto.departmentId || dto.unitId || dto.branchId) {
      await this.validateOrgReferences(
        dto.departmentId ?? staff.departmentId.toString(),
        dto.unitId ?? staff.unitId.toString(),
        dto.branchId ?? staff.branchId.toString(),
      );
    }

    if (dto.managerId !== undefined && dto.managerId !== '') {
      if (dto.managerId === staffId) {
        throw new BadRequestException('A staff member cannot report to themselves');
      }
      const managerExists = await this.staffModel.exists({ _id: dto.managerId });
      if (!managerExists) {
        throw new BadRequestException(`Manager ${dto.managerId} does not exist`);
      }
    }

    const nextEmail = dto.email?.toLowerCase();
    if ((nextEmail !== undefined && nextEmail !== staff.email) || (dto.phoneNumber !== undefined && dto.phoneNumber !== staff.phoneNumber)) {
      const existing = await this.staffModel
        .findOne({
          _id: { $ne: staff._id },
          $or: [
            ...(nextEmail !== undefined ? [{ email: nextEmail }] : []),
            ...(dto.phoneNumber !== undefined ? [{ phoneNumber: dto.phoneNumber }] : []),
          ],
        })
        .lean()
        .exec();
      if (existing) {
        throw new ConflictException(
          nextEmail && existing.email === nextEmail
            ? `A staff member with email ${dto.email} already exists`
            : `A staff member with phone number ${dto.phoneNumber} already exists`,
        );
      }
    }

    // Only the fields actually touched go in the audit entry — a full
    // before/after document dump would be noise (and `staff.toObject()`
    // doesn't structurally satisfy AuditService's `Record<string, unknown>`
    // param anyway).
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};

    const applyChange = <K extends keyof StaffDocument>(field: K, value: StaffDocument[K]): void => {
      before[field as string] = staff[field];
      staff[field] = value;
      after[field as string] = value;
    };

    if (dto.firstName !== undefined) applyChange('firstName', dto.firstName);
    if (dto.lastName !== undefined) applyChange('lastName', dto.lastName);
    if (nextEmail !== undefined) applyChange('email', nextEmail);
    if (dto.phoneNumber !== undefined) applyChange('phoneNumber', dto.phoneNumber);
    if (dto.role !== undefined) applyChange('role', dto.role);
    // Same MARKETER-is-always-Initiator / Reviewer-is-not-newly-assignable
    // rule as creation time (resolveUserType) — the *effective* role is
    // whatever this same call is changing it to (dto.role), falling back to
    // the staff member's current role otherwise, so a role change and a
    // userType change in the same request are validated against each other
    // consistently rather than against a role that's about to be stale.
    // Runs even when `dto.userType` itself isn't part of this request: a
    // role change INTO MARKETER must still force Initiator (never silently
    // leave a Marketer with a stale Authorizer/Reviewer value from before
    // the demotion), and a role change AWAY FROM MARKETER with a
    // now-invalid leftover MARKETER-only value has nothing else to fall
    // back to either.
    const effectiveRole = dto.role ?? staff.role;
    if (dto.userType !== undefined || dto.role !== undefined) {
      const resolved = this.resolveUserType(effectiveRole, dto.userType ?? staff.userType);
      if (resolved !== staff.userType) {
        applyChange('userType', resolved);
      }
    }
    if (dto.departmentId !== undefined) applyChange('departmentId', new Types.ObjectId(dto.departmentId));
    if (dto.unitId !== undefined) applyChange('unitId', new Types.ObjectId(dto.unitId));
    if (dto.branchId !== undefined) applyChange('branchId', new Types.ObjectId(dto.branchId));
    if (dto.employmentType !== undefined) applyChange('employmentType', dto.employmentType);
    if (dto.salaryGrade !== undefined) applyChange('salaryGrade', dto.salaryGrade);
    if (dto.managerId !== undefined) {
      applyChange('managerId', dto.managerId ? new Types.ObjectId(dto.managerId) : null);
    }
    if (dto.residentialAddress !== undefined) applyChange('residentialAddress', dto.residentialAddress);
    if (dto.kyc !== undefined) {
      applyChange('kyc', { ...dto.kyc, dateOfBirth: new Date(dto.kyc.dateOfBirth) });
    }
    if (dto.nextOfKin !== undefined) applyChange('nextOfKin', dto.nextOfKin);
    if (dto.reference !== undefined) applyChange('reference', dto.reference);

    await staff.save();

    await this.auditService.record({
      actorId: updatedBy,
      action: 'STAFF_PROFILE_UPDATED',
      entityType: 'STAFF',
      entityId: staffId,
      before,
      after,
    });

    return staff;
  }

  /**
   * PATCH /staff/:id/compliance — manual admin sign-off toggles; no live
   * verification provider behind any of the three (unlike BVN, which goes
   * through POST /staff/:id/verify-bvn instead). See UpdateStaffComplianceDto.
   */
  async updateCompliance(
    staffId: string,
    dto: UpdateStaffComplianceDto,
    updatedBy: string,
  ): Promise<StaffDocument> {
    const staff = await this.findById(staffId);

    const before = {
      ninVerified: staff.ninVerified,
      guarantorFormVerified: staff.guarantorFormVerified,
      offerLetterVerified: staff.offerLetterVerified,
    };

    if (dto.ninVerified !== undefined) staff.ninVerified = dto.ninVerified;
    if (dto.guarantorFormVerified !== undefined) staff.guarantorFormVerified = dto.guarantorFormVerified;
    if (dto.offerLetterVerified !== undefined) staff.offerLetterVerified = dto.offerLetterVerified;
    await staff.save();

    await this.auditService.record({
      actorId: updatedBy,
      action: 'STAFF_COMPLIANCE_UPDATED',
      entityType: 'STAFF',
      entityId: staffId,
      before,
      after: {
        ninVerified: staff.ninVerified,
        guarantorFormVerified: staff.guarantorFormVerified,
        offerLetterVerified: staff.offerLetterVerified,
      },
    });

    return staff;
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /** Best-effort — called from AuthService.verifyLoginOtp on every successful login; never blocks the login itself. */
  async recordLogin(staffId: string): Promise<void> {
    await this.staffModel.updateOne({ _id: staffId }, { $set: { lastLoginAt: new Date() } }).exec();
  }

  /**
   * GET /staff/:id/performance — computed fresh on every call, never cached
   * on the Staff document, so it's never stale. Cross-module reads only
   * (Customer.createdBy / Group.createdBy / Loan.raisedBy) — same
   * raw-model-injection pattern as `branchModel` above, not
   * CustomersService/GroupsService/LoansService.
   */
  async getPerformanceSummary(staffId: string): Promise<StaffPerformanceSummaryDto> {
    const staff = await this.findById(staffId);
    const staffObjectId = new Types.ObjectId(staffId);

    const [customersOnboarded, activeGroups, loansRaised] = await Promise.all([
      this.customerModel.countDocuments({ createdBy: staffObjectId }).exec(),
      this.groupModel.countDocuments({ createdBy: staffObjectId, status: GroupStatus.ACTIVE }).exec(),
      this.loanModel.countDocuments({ raisedBy: staffObjectId }).exec(),
    ]);

    const dto = new StaffPerformanceSummaryDto();
    dto.customersOnboarded = customersOnboarded;
    dto.activeGroups = activeGroups;
    dto.loansRaised = loansRaised;
    dto.lastLoginAt = staff.lastLoginAt;
    return dto;
  }

  /** GET /staff/:id/activity — "what has this staff member done," sourced from the real audit trail, not a hand-edited log. */
  async getActivity(staffId: string): Promise<StaffActivityEntryDto[]> {
    await this.findById(staffId); // 404s on a bad id, same as every other :id route here
    const logs = await this.auditService.findByActor(staffId);
    return logs.map((log) => StaffActivityEntryDto.fromDocument(log));
  }

  async findById(id: string): Promise<StaffDocument> {
    const staff = await this.staffModel.findById(id).exec();
    if (!staff) {
      throw new NotFoundException(`Staff ${id} not found`);
    }
    return staff;
  }

  /**
   * *** BUG FIX, DISCOVERED IN PHASE 11 — SEE PHASE_11_NOTES.md ***
   * A raw string `branchId`/`departmentId` passed straight into `.find()`
   * does not reliably auto-cast against this schema's `Types.ObjectId`
   * fields in this project's Mongoose setup — found via a new test for
   * `findActiveByRoleAndBranch` (also added in Phase 11) that failed with a
   * silent empty-array result rather than a thrown error. Explicit casting
   * fixes it; this means `GET /staff?branchId=...` was silently returning
   * an empty list for any branch filter before this fix.
   */
  async findAll(filter: { branchId?: string; departmentId?: string; status?: StaffStatus }) {
    const castFilter: Record<string, unknown> = { ...filter };
    if (filter.branchId) {
      castFilter.branchId = new Types.ObjectId(filter.branchId);
    }
    if (filter.departmentId) {
      castFilter.departmentId = new Types.ObjectId(filter.departmentId);
    }
    return this.staffModel.find(castFilter).sort({ createdAt: -1 }).exec();
  }

  /**
   * Added in Phase 11 for `NotificationService.resolveInvolvedParties` —
   * batch lookup by id, silently skipping any id that no longer resolves
   * (a staff record was never expected to disappear, but a resolver
   * building a recipient list shouldn't throw over one stale id).
   */
  async findByIds(ids: string[]): Promise<StaffDocument[]> {
    if (ids.length === 0) {
      return [];
    }
    return this.staffModel.find({ _id: { $in: ids } }).exec();
  }

  /**
   * Added in Phase 11 — the branch-level Admin/SuperAdmin fallback in
   * `resolveInvolvedParties` when no admin has acted on the related
   * workflow request yet. Active staff only (a disabled Admin shouldn't be
   * notified of anything new).
   */
  async findActiveByRoleAndBranch(roles: StaffRole[], branchId: string): Promise<StaffDocument[]> {
    return this.staffModel
      .find({
        role: { $in: roles },
        branchId: new Types.ObjectId(branchId),
        status: StaffStatus.ACTIVE,
      })
      .exec();
  }

  /**
   * Same shape as `findActiveByRoleAndBranch` above, minus the branch
   * filter — added for `NotificationInboxService.persistCopies`'s SuperAdmin
   * fan-out (every in-app notification also mirrors to every active
   * SuperAdmin, org-wide, not just one branch's).
   */
  async findActiveByRole(roles: StaffRole[]): Promise<StaffDocument[]> {
    return this.staffModel.find({ role: { $in: roles }, status: StaffStatus.ACTIVE }).exec();
  }

  /** Includes passwordHash — only ever called from AuthService for a login attempt. */
  async findByEmailWithPassword(email: string): Promise<StaffDocument | null> {
    return this.staffModel.findOne({ email: email.toLowerCase() }).select('+passwordHash').exec();
  }

  /**
   * No passwordHash — for anything that needs to look a staff member up by
   * email without touching credentials. Used by `PasswordResetService`,
   * which never needs the current password (the emailed reset code is the
   * proof of possession, not the old password — see `setPassword` below).
   */
  async findByEmail(email: string): Promise<StaffDocument | null> {
    return this.staffModel.findOne({ email: email.toLowerCase() }).exec();
  }

  /** Lightweight live-status lookup — used by JwtStrategy on every authenticated request. */
  async getStatus(staffId: string): Promise<StaffStatus | null> {
    const staff = await this.staffModel.findById(staffId).select('status').lean().exec();
    return staff?.status ?? null;
  }

  /**
   * Same "one lightweight read, live on every request" treatment as
   * `getStatus` (see JwtStrategy.validate) — added alongside it (not
   * folded into it) so `getStatus`'s existing single-field shape/callers
   * are undisturbed. `userType` drives the Initiator/Authorizer RBAC
   * filter (RbacService.resolveContext) — re-read fresh every request so a
   * userType change takes effect immediately, not after the access token
   * expires.
   */
  async getStatusAndUserType(
    staffId: string,
  ): Promise<{ status: StaffStatus; userType: StaffUserType } | null> {
    const staff = await this.staffModel.findById(staffId).select('status userType').lean().exec();
    return staff ? { status: staff.status, userType: staff.userType } : null;
  }

  // ---------------------------------------------------------------------------
  // Disable / enable
  // ---------------------------------------------------------------------------

  async disable(staffId: string, disabledBy: string, reason: string): Promise<StaffDocument> {
    const staff = await this.findById(staffId);
    if (staff.status === StaffStatus.DISABLED) {
      throw new BadRequestException(`Staff ${staffId} is already disabled`);
    }

    const previousStatus = staff.status;
    const now = new Date();
    staff.status = StaffStatus.DISABLED;
    staff.disabledReason = reason;
    staff.disabledBy = new Types.ObjectId(disabledBy);
    staff.disabledAt = now;
    await staff.save();

    // A disabled staff member must fail authentication immediately — revoking
    // every outstanding refresh token closes that door even though their
    // current (short-lived) access token may still be technically unexpired
    // for a few more minutes; JwtStrategy's live status check closes the rest.
    await this.refreshTokenService.revokeAllForStaff(staffId);

    // Sensitive action — its own explicit audit call beyond the generic trail.
    await this.auditService.record({
      actorId: disabledBy,
      action: 'STAFF_DISABLED',
      entityType: 'STAFF',
      entityId: staffId,
      before: { status: previousStatus },
      after: { status: StaffStatus.DISABLED },
      metadata: { reason },
    });

    this.emitStaffDisabled(staff, disabledBy);

    return staff;
  }

  /** Shared by `disable()` — see `STAFF_DISABLED_EVENT`'s own doc comment. */
  private emitStaffDisabled(staff: StaffDocument, disabledByStaffId: string): void {
    const event: StaffDisabledEvent = {
      staffId: staff._id.toString(),
      firstName: staff.firstName,
      email: staff.email,
      phoneNumber: staff.phoneNumber,
      reason: staff.disabledReason ?? '',
      disabledByStaffId,
      disabledAt: staff.disabledAt as Date,
    };
    this.eventEmitter.emit(STAFF_DISABLED_EVENT, event);
  }

  async enable(staffId: string, enabledBy: string): Promise<StaffDocument> {
    const staff = await this.findById(staffId);
    if (staff.status !== StaffStatus.DISABLED) {
      throw new BadRequestException(`Staff ${staffId} is not disabled`);
    }

    staff.status = StaffStatus.ACTIVE;
    staff.disabledReason = null;
    staff.disabledBy = null;
    staff.disabledAt = null;
    await staff.save();

    await this.auditService.record({
      actorId: enabledBy,
      action: 'STAFF_ENABLED',
      entityType: 'STAFF',
      entityId: staffId,
      before: { status: StaffStatus.DISABLED },
      after: { status: StaffStatus.ACTIVE },
    });

    return staff;
  }

  // ---------------------------------------------------------------------------
  // BVN (Phase 5) — compulsory, but not a blocker; see PHASE_5_NOTES.md for
  // the enforcement level chosen (visibility only, no functional block).
  // ---------------------------------------------------------------------------

  /**
   * Staff skip the OTP consent flow entirely — that flow is customer
   * self-attestation via their own registered phone. Staff BVN is an
   * internal compliance check an Admin/HR performs on the staff member's
   * behalf, so this goes straight to the no-consent `directVerify` endpoint.
   */
  async verifyBvn(staffId: string, bvn: string, verifiedBy: string): Promise<StaffDocument> {
    const staff = await this.findById(staffId);

    const details: BvnDetails = await this.bvnAdapter.directVerify(bvn, {
      calledBy: verifiedBy,
      entityType: 'STAFF',
      entityId: staffId,
    });

    staff.bvnEncrypted = this.encryptionService.encrypt(details.bvn);
    staff.bvnVerified = true;
    staff.bvnVerifiedAt = new Date();
    staff.bvnVerifiedBy = new Types.ObjectId(verifiedBy);
    await staff.save();

    await this.auditService.record({
      actorId: verifiedBy,
      action: 'STAFF_BVN_VERIFIED',
      entityType: 'STAFF',
      entityId: staffId,
      after: { bvnVerified: true },
    });

    return staff;
  }

  /**
   * Same no-consent `directVerify` call as `verifyBvn` above, but usable
   * *before* a Staff record exists — for the onboarding form's "Verify"
   * button, so an onboarder can confirm a BVN resolves to a real identity
   * before ever submitting the form. Nothing is persisted here (there's no
   * Staff document to persist onto yet); the provider call itself is still
   * logged via BvnCallLogService (see the adapter), just with no
   * `calledForEntityId` — `BvnCallContext.entityId` is optional precisely
   * for this "no entity yet" case (see BvnVerificationAdapter's own
   * comment). The real, persisted verification still only happens via
   * `verifyBvn` once the staff record exists.
   */
  async verifyBvnPreview(bvn: string, calledBy: string): Promise<BvnPreviewResponseDto> {
    const details = await this.bvnAdapter.directVerify(bvn, {
      calledBy,
      entityType: 'STAFF',
    });

    return {
      bvn: details.bvn,
      firstName: details.firstName,
      lastName: details.lastName,
      otherNames: details.otherNames,
      dateOfBirth: details.dateOfBirth,
      phoneNumber: details.phoneNumber,
    };
  }

  /** For an Admin compliance dashboard — see PHASE_5_NOTES.md, option (c). */
  async findStaffWithUnverifiedBvn(): Promise<StaffDocument[]> {
    return this.staffModel.find({ bvnVerified: false }).sort({ createdAt: -1 }).exec();
  }

  // ---------------------------------------------------------------------------
  // Password change — see Staff.mustChangePassword's own doc comment.
  // ---------------------------------------------------------------------------

  /**
   * Self-service only (the caller is always the authenticated staff member
   * themself — see AuthController) — there is no separate "Admin resets
   * someone else's password" path today. Requires the *current* password
   * (proof of possession, not just a valid access token — the same
   * "re-authenticate for a sensitive change" posture most systems use for
   * this exact action) and revokes every outstanding refresh token
   * afterward, same as `disable()`: a changed password should force
   * re-login everywhere else it's still signed in. Also emits
   * `STAFF_PASSWORD_CHANGED_EVENT` so the staff member gets a confirmation
   * email even though they were already logged in when they made the change.
   */
  async changePassword(
    staffId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const staff = await this.staffModel.findById(staffId).select('+passwordHash').exec();
    if (!staff) {
      throw new NotFoundException(`Staff ${staffId} not found`);
    }

    const currentMatches = await bcrypt.compare(currentPassword, staff.passwordHash);
    if (!currentMatches) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    staff.passwordHash = await bcrypt.hash(newPassword, BCRYPT_SALT_ROUNDS);
    staff.mustChangePassword = false;
    await staff.save();

    await this.refreshTokenService.revokeAllForStaff(staffId);

    await this.auditService.record({
      actorId: staffId,
      action: 'STAFF_PASSWORD_CHANGED',
      entityType: 'STAFF',
      entityId: staffId,
    });

    const event: StaffPasswordChangedEvent = {
      staffId: staff._id.toString(),
      firstName: staff.firstName,
      email: staff.email,
    };
    this.eventEmitter.emit(STAFF_PASSWORD_CHANGED_EVENT, event);
  }

  /**
   * The forgot-password counterpart to `changePassword` — used exclusively
   * by `PasswordResetService.resetPassword`, once it has already verified
   * the emailed reset code itself. No *current* password check here: the
   * verified code is this path's proof of possession, playing the same
   * role `currentPassword` plays above. Same side effects otherwise
   * (`mustChangePassword` cleared, every outstanding refresh token
   * revoked, audited under a distinct action so the trail shows which path
   * was used).
   */
  async setPassword(staffId: string, newPassword: string): Promise<void> {
    const staff = await this.findById(staffId);

    staff.passwordHash = await bcrypt.hash(newPassword, BCRYPT_SALT_ROUNDS);
    staff.mustChangePassword = false;
    await staff.save();

    await this.refreshTokenService.revokeAllForStaff(staffId);

    await this.auditService.record({
      actorId: staffId,
      action: 'STAFF_PASSWORD_RESET_VIA_FORGOT_PASSWORD',
      entityType: 'STAFF',
      entityId: staffId,
    });
  }
}
