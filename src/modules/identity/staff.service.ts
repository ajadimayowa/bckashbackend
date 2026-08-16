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
import * as bcrypt from 'bcryptjs';
import { Model, Types } from 'mongoose';

import { ModuleName, StaffRole, StaffStatus } from '../../common/enums/identity.enums';
import { WorkflowEntityType } from '../../common/enums/workflow.enums';
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
// Cross-module read only — the raw Branch model, not branches' BranchesService
// or BranchesModule. See PHASE_3_NOTES.md ("cross-module existence checks").
import { Branch, BranchDocument } from '../branches/schemas/branch.schema';
import { DepartmentsService } from './departments.service';
import { CreateStaffDirectDto } from './dto/create-staff-direct.dto';
import { InitiateStaffOnboardingDto } from './dto/initiate-staff-onboarding.dto';
import { RefreshTokenService } from './refresh-token.service';
import { Staff, StaffDocument } from './schemas/staff.schema';
import { UnitsService } from './units.service';
import { WorkflowRequestDocument } from '../../platform/workflow-engine/schemas/workflow-request.schema';

const BCRYPT_SALT_ROUNDS = 12;

interface StaffOnboardingPayload {
  firstName: string;
  lastName: string;
  email: string;
  phoneNumber: string;
  passwordHash: string;
  departmentId: string;
  unitId: string;
  branchId: string;
  moduleAccess: ModuleName[];
}

@Injectable()
export class StaffService implements OnModuleInit {
  constructor(
    @InjectModel(Staff.name) private readonly staffModel: Model<StaffDocument>,
    @InjectModel(Branch.name) private readonly branchModel: Model<BranchDocument>,
    private readonly departmentsService: DepartmentsService,
    private readonly unitsService: UnitsService,
    private readonly workflowEngineService: WorkflowEngineService,
    private readonly auditService: AuditService,
    private readonly refreshTokenService: RefreshTokenService,
    @Inject(BVN_VERIFICATION_ADAPTER) private readonly bvnAdapter: BvnVerificationAdapter,
    private readonly encryptionService: EncryptionService,
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
  }

  private async validateOrgReferences(
    departmentId: string,
    unitId: string,
    branchId: string,
  ): Promise<void> {
    await this.departmentsService.assertExists(departmentId);
    await this.unitsService.assertBelongsToDepartment(unitId, departmentId);
    const branchExists = await this.branchModel.exists({ _id: branchId });
    if (!branchExists) {
      throw new BadRequestException(`Branch ${branchId} does not exist`);
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
  // Onboarding (workflow-mediated — MARKETER only)
  // ---------------------------------------------------------------------------

  async initiateOnboarding(
    dto: InitiateStaffOnboardingDto,
    initiatedBy: string,
  ): Promise<WorkflowRequestDocument> {
    await this.validateOrgReferences(dto.departmentId, dto.unitId, dto.branchId);
    await this.assertEmailAndPhoneAvailable(dto.email, dto.phoneNumber);

    // Hashed *before* the workflow payload is ever persisted — a plaintext
    // password must never sit in a WorkflowRequest document waiting for
    // review. See PHASE_3_NOTES.md.
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_SALT_ROUNDS);

    const payload: StaffOnboardingPayload = {
      firstName: dto.firstName,
      lastName: dto.lastName,
      email: dto.email.toLowerCase(),
      phoneNumber: dto.phoneNumber,
      passwordHash,
      departmentId: dto.departmentId,
      unitId: dto.unitId,
      branchId: dto.branchId,
      moduleAccess: dto.moduleAccess,
    };

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

    const created = await this.staffModel.create({
      firstName: payload.firstName,
      lastName: payload.lastName,
      email: payload.email,
      phoneNumber: payload.phoneNumber,
      passwordHash: payload.passwordHash,
      role: StaffRole.MARKETER,
      departmentId: payload.departmentId,
      unitId: payload.unitId,
      branchId: payload.branchId,
      moduleAccess: payload.moduleAccess,
      status: StaffStatus.ACTIVE,
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
  }

  // ---------------------------------------------------------------------------
  // Direct creation (SuperAdmin only — MANAGER/ADMIN/APPROVER, see PHASE_3_NOTES.md)
  // ---------------------------------------------------------------------------

  async createDirect(dto: CreateStaffDirectDto, createdBy: string): Promise<StaffDocument> {
    await this.validateOrgReferences(dto.departmentId, dto.unitId, dto.branchId);
    await this.assertEmailAndPhoneAvailable(dto.email, dto.phoneNumber);

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_SALT_ROUNDS);

    const created = await this.staffModel.create({
      firstName: dto.firstName,
      lastName: dto.lastName,
      email: dto.email.toLowerCase(),
      phoneNumber: dto.phoneNumber,
      passwordHash,
      role: dto.role,
      departmentId: dto.departmentId,
      unitId: dto.unitId,
      branchId: dto.branchId,
      moduleAccess: dto.moduleAccess,
      status: StaffStatus.ACTIVE,
    });

    await this.auditService.record({
      actorId: createdBy,
      action: 'STAFF_CREATED_DIRECT',
      entityType: 'STAFF',
      entityId: created._id.toString(),
      after: { email: created.email, role: created.role, branchId: dto.branchId },
    });

    return created;
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  async findById(id: string): Promise<StaffDocument> {
    const staff = await this.staffModel.findById(id).exec();
    if (!staff) {
      throw new NotFoundException(`Staff ${id} not found`);
    }
    return staff;
  }

  async findAll(filter: { branchId?: string; departmentId?: string; status?: StaffStatus }) {
    return this.staffModel.find(filter).sort({ createdAt: -1 }).exec();
  }

  /** Includes passwordHash — only ever called from AuthService for a login attempt. */
  async findByEmailWithPassword(email: string): Promise<StaffDocument | null> {
    return this.staffModel.findOne({ email: email.toLowerCase() }).select('+passwordHash').exec();
  }

  /** Lightweight live-status lookup — used by JwtStrategy on every authenticated request. */
  async getStatus(staffId: string): Promise<StaffStatus | null> {
    const staff = await this.staffModel.findById(staffId).select('status').lean().exec();
    return staff?.status ?? null;
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

    return staff;
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

  /** For an Admin compliance dashboard — see PHASE_5_NOTES.md, option (c). */
  async findStaffWithUnverifiedBvn(): Promise<StaffDocument[]> {
    return this.staffModel.find({ bvnVerified: false }).sort({ createdAt: -1 }).exec();
  }
}
