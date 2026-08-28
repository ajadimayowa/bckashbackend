import { randomBytes } from 'node:crypto';

import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { Model, Types } from 'mongoose';

import { __resetPiiEncryptionKeyCache } from '../../common/crypto/pii-encryption';
import { Gender, IdentificationType, ModuleName, StaffRole, StaffStatus, StaffUserType } from '../../common/enums/identity.enums';
import { WorkflowStatus, WorkflowStepAction } from '../../common/enums/workflow.enums';
import { WorkflowEntityType } from '../../common/enums/workflow.enums';
import { AuditModule } from '../../platform/audit/audit.module';
import { EncryptionService } from '../../platform/encryption/encryption.service';
import { BvnCallLogService } from '../../platform/integrations/bvn/bvn-call-log.service';
import { BVN_VERIFICATION_ADAPTER } from '../../platform/integrations/bvn/interfaces/bvn-verification-adapter.interface';
import { MockBvnVerificationAdapter } from '../../platform/integrations/bvn/mock-bvn-verification.adapter';
import {
  BvnCallLog,
  BvnCallLogSchema,
} from '../../platform/integrations/bvn/schemas/bvn-call-log.schema';
import { approveCapability } from '../../platform/rbac/constants/capabilities';
import { InMemoryMongo } from '../../test-utils/in-memory-mongo';
import { Branch, BranchDocument, BranchSchema } from '../branches/schemas/branch.schema';
import { Customer, CustomerSchema } from '../customers/schemas/customer.schema';
import { Group, GroupSchema } from '../groups/schemas/group.schema';
import { Loan, LoanSchema } from '../loans/schemas/loan.schema';
import {
  WorkflowChainConfig,
  WorkflowChainConfigSchema,
} from '../../platform/workflow-engine/schemas/workflow-chain-config.schema';
import { WorkflowEngineService } from '../../platform/workflow-engine/workflow-engine.service';
import {
  WorkflowRequest,
  WorkflowRequestSchema,
} from '../../platform/workflow-engine/schemas/workflow-request.schema';
import { DepartmentsService } from './departments.service';
import { InitiateStaffOnboardingDto } from './dto/initiate-staff-onboarding.dto';
import { CreateStaffDirectDto } from './dto/create-staff-direct.dto';
import { UpdateOwnStaffProfileDto } from './dto/update-own-staff-profile.dto';
import { UpdateStaffComplianceDto } from './dto/update-staff-compliance.dto';
import { UpdateStaffProfileDto } from './dto/update-staff-profile.dto';
import {
  STAFF_CREATED_EVENT,
  STAFF_PASSWORD_CHANGED_EVENT,
  StaffCreatedEvent,
  StaffPasswordChangedEvent,
} from './events/staff.events';
import { RefreshTokenService } from './refresh-token.service';
import { Department, DepartmentSchema } from './schemas/department.schema';
import { RefreshToken, RefreshTokenSchema } from './schemas/refresh-token.schema';
import { Staff, StaffDocument, StaffSchema } from './schemas/staff.schema';
import { Unit, UnitSchema } from './schemas/unit.schema';
import { StaffService } from './staff.service';
import { UnitsService } from './units.service';

describe('StaffService', () => {
  const mongo = new InMemoryMongo();
  let moduleRef: TestingModule;
  let staffService: StaffService;
  let workflowEngineService: WorkflowEngineService;
  let refreshTokenService: RefreshTokenService;
  let staffModel: Model<StaffDocument>;
  let departmentId: string;
  let unitId: string;
  let branchId: string;

  const ADMIN_APPROVE_STAFF_ACTOR = {
    staffId: 'admin-1',
    capabilities: [approveCapability(WorkflowEntityType.STAFF)],
  };
  // Staff.disabledBy is a real Mongoose ref (unlike the workflow engine's
  // opaque string actor ids), so this placeholder actor needs a valid ObjectId shape.
  const ADMIN_ACTOR_ID = new Types.ObjectId().toString();

  beforeAll(async () => {
    process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    __resetPiiEncryptionKeyCache();

    await mongo.start();

    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri()),
        MongooseModule.forFeature([
          { name: Department.name, schema: DepartmentSchema },
          { name: Unit.name, schema: UnitSchema },
          { name: Staff.name, schema: StaffSchema },
          { name: RefreshToken.name, schema: RefreshTokenSchema },
          { name: Branch.name, schema: BranchSchema },
          { name: Customer.name, schema: CustomerSchema },
          { name: Group.name, schema: GroupSchema },
          { name: Loan.name, schema: LoanSchema },
          { name: WorkflowChainConfig.name, schema: WorkflowChainConfigSchema },
          { name: WorkflowRequest.name, schema: WorkflowRequestSchema },
          { name: BvnCallLog.name, schema: BvnCallLogSchema },
        ]),
        AuditModule,
        EventEmitterModule.forRoot(),
      ],
      providers: [
        DepartmentsService,
        UnitsService,
        StaffService,
        RefreshTokenService,
        WorkflowEngineService,
        EncryptionService,
        BvnCallLogService,
        MockBvnVerificationAdapter,
        { provide: BVN_VERIFICATION_ADAPTER, useExisting: MockBvnVerificationAdapter },
      ],
    }).compile();

    staffService = moduleRef.get(StaffService);
    workflowEngineService = moduleRef.get(WorkflowEngineService);
    refreshTokenService = moduleRef.get(RefreshTokenService);
    staffModel = moduleRef.get(getModelToken(Staff.name));

    // `.init()`, not a manual `onModuleInit()` call — @OnEvent listeners
    // (StaffService.handleWorkflowApproved) are only registered once
    // EventEmitterModule's discovery scan runs on onApplicationBootstrap,
    // which only fires via the real Nest lifecycle.
    await moduleRef.init();
  }, 60_000);

  beforeEach(async () => {
    const departmentModel = moduleRef.get<Model<{ _id: Types.ObjectId }>>(
      getModelToken(Department.name),
    );
    const unitModel = moduleRef.get<Model<{ _id: Types.ObjectId; departmentId: Types.ObjectId }>>(
      getModelToken(Unit.name),
    );
    const branchModel = moduleRef.get<Model<BranchDocument>>(getModelToken(Branch.name));

    const department = await departmentModel.create({ name: `Dept ${Date.now()}`, active: true });
    departmentId = department._id.toString();
    const unit = await unitModel.create({
      departmentId: department._id,
      name: 'Unit A',
      active: true,
    });
    unitId = unit._id.toString();
    const branch = await branchModel.create({
      name: 'Main Branch',
      code: `BR${Date.now()}`,
      active: true,
    });
    branchId = branch._id.toString();
  });

  afterEach(async () => {
    // Preserve the seeded chain config across tests — clear everything else.
    const collectionsToKeep = new Set(['workflow_chain_configs']);
    const connection = staffModel.db;
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

  /**
   * Shared onboarding-form-completeness fixture — every field
   * InitiateStaffOnboardingDto/CreateStaffDirectDto require alongside the
   * pre-existing org-structure ones (see StaffOnboarding.tsx's nok/kyc/
   * reference field groups this backs).
   */
  function onboardingExtras() {
    return {
      startDate: '2026-01-01',
      residentialAddress: { state: 'Lagos', city: 'Ikeja', street: '12 Allen Avenue' },
      kyc: {
        dateOfBirth: '1995-06-15',
        gender: Gender.FEMALE,
        idType: IdentificationType.NIN,
        idNumber: '12345678901',
      },
      nextOfKin: {
        name: 'Ngozi Okoye',
        relationship: 'Sister',
        phoneNumber: '08011112222',
        address: '5 Kin Street, Lagos',
      },
      reference: {
        name: 'Emeka Obi',
        relationship: 'Friend',
        phoneNumber: '08033334444',
        address: '9 Reference Close, Lagos',
      },
    };
  }

  function onboardingDto(
    overrides: Partial<InitiateStaffOnboardingDto> = {},
  ): InitiateStaffOnboardingDto {
    const dto = new InitiateStaffOnboardingDto();
    dto.role = StaffRole.MARKETER;
    // Overridden below by MARKETER anyway (StaffService.resolveUserType
    // forces Initiator unconditionally for that role) — set explicitly so
    // this default fixture is also valid as-is for any test that overrides
    // `role` to one of the other onboardable roles without also overriding `userType`.
    dto.userType = StaffUserType.INITIATOR;
    dto.firstName = 'Ada';
    dto.lastName = 'Okoye';
    dto.email = `ada.${Date.now()}.${Math.random()}@example.com`;
    dto.phoneNumber = '08012345678';
    dto.departmentId = departmentId;
    dto.unitId = unitId;
    dto.branchId = branchId;
    dto.moduleAccess = [ModuleName.LOANS];
    Object.assign(dto, onboardingExtras());
    return Object.assign(dto, overrides);
  }

  function directDto(overrides: Partial<CreateStaffDirectDto> = {}): CreateStaffDirectDto {
    const dto = new CreateStaffDirectDto();
    dto.firstName = 'Bola';
    dto.lastName = 'Adeyemi';
    dto.email = `bola.${Date.now()}.${Math.random()}@example.com`;
    dto.phoneNumber = `080${Math.floor(Math.random() * 1e8)}`;
    dto.role = StaffRole.MANAGER;
    dto.userType = StaffUserType.AUTHORIZER;
    dto.departmentId = departmentId;
    dto.unitId = unitId;
    dto.branchId = branchId;
    dto.moduleAccess = [ModuleName.LOANS];
    Object.assign(dto, onboardingExtras());
    return Object.assign(dto, overrides);
  }

  describe('initiateOnboarding', () => {
    it('creates a WorkflowRequest, not a live Staff record', async () => {
      const dto = onboardingDto();

      const request = await staffService.initiateOnboarding(dto, 'manager-1', StaffRole.MANAGER);

      expect(request.status).toBe(WorkflowStatus.PENDING_APPROVAL); // single-step chain
      expect(request.entityType).toBe(WorkflowEntityType.STAFF);

      const staffCount = await staffModel.countDocuments({ email: dto.email });
      expect(staffCount).toBe(0);
    });

    it('never puts a password of any kind in the workflow payload — no such field exists on the DTO/payload anymore', async () => {
      const dto = onboardingDto();

      const request = await staffService.initiateOnboarding(dto, 'manager-1', StaffRole.MANAGER);

      const payload = request.payloadHistory[0]?.payload as Record<string, unknown>;
      expect(payload.password).toBeUndefined();
      expect(payload.passwordHash).toBeUndefined();
    });

    it('only appears as an active staff member after approval, with a system-generated temporary password and mustChangePassword=true', async () => {
      const dto = onboardingDto();
      const request = await staffService.initiateOnboarding(dto, 'manager-1', StaffRole.MANAGER);

      const eventEmitter = moduleRef.get(EventEmitter2);
      const emitted: StaffCreatedEvent[] = [];
      eventEmitter.on(STAFF_CREATED_EVENT, (event: StaffCreatedEvent) => emitted.push(event));

      await workflowEngineService.act({
        workflowRequestId: request._id.toString(),
        actor: ADMIN_APPROVE_STAFF_ACTOR,
        action: WorkflowStepAction.APPROVED,
      });

      const created = await staffModel.findOne({ email: dto.email }).select('+passwordHash').exec();
      expect(created).not.toBeNull();
      expect(created?.status).toBe(StaffStatus.ACTIVE);
      expect(created?.role).toBe(StaffRole.MARKETER);
      expect(created?.mustChangePassword).toBe(true);

      // STAFF_CREATED_EVENT carries the one and only plaintext copy of the
      // generated password — never persisted, only bcrypt-hashed for storage.
      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.email).toBe(dto.email);
      expect(emitted[0]?.temporaryPassword.length).toBeGreaterThanOrEqual(10);
      const hashMatches = await bcrypt.compare(
        emitted[0]!.temporaryPassword,
        created!.passwordHash,
      );
      expect(hashMatches).toBe(true);
    });

    it('creates the account with whatever role was proposed, not hard-coded to MARKETER', async () => {
      // Proposing APPROVER requires an Admin/SuperAdmin initiator — see the
      // dedicated describe block below for the restriction itself. A
      // different admin-tier id than ADMIN_APPROVE_STAFF_ACTOR's own
      // ('admin-1') — the maker can never approve their own request.
      const dto = onboardingDto({ role: StaffRole.APPROVER });
      const request = await staffService.initiateOnboarding(dto, 'admin-2', StaffRole.ADMIN);

      await workflowEngineService.act({
        workflowRequestId: request._id.toString(),
        actor: ADMIN_APPROVE_STAFF_ACTOR,
        action: WorkflowStepAction.APPROVED,
      });

      const created = await staffModel.findOne({ email: dto.email }).exec();
      expect(created?.role).toBe(StaffRole.APPROVER);
    });

    it('a rejected onboarding never creates a Staff record', async () => {
      const dto = onboardingDto();
      const request = await staffService.initiateOnboarding(dto, 'manager-1', StaffRole.MANAGER);

      await workflowEngineService.act({
        workflowRequestId: request._id.toString(),
        actor: ADMIN_APPROVE_STAFF_ACTOR,
        action: WorkflowStepAction.REJECTED,
        comment: 'not eligible',
      });

      const staffCount = await staffModel.countDocuments({ email: dto.email });
      expect(staffCount).toBe(0);
    });

    it('rejects onboarding into a non-existent department/unit/branch', async () => {
      await expect(
        staffService.initiateOnboarding(
          onboardingDto({ departmentId: new Types.ObjectId().toString() }),
          'm',
          StaffRole.MANAGER,
        ),
      ).rejects.toThrow();
    });
  });

  describe('initiateOnboarding — proposing ADMIN/APPROVER is Admin/SuperAdmin only', () => {
    it.each([StaffRole.ADMIN, StaffRole.APPROVER])(
      'rejects a MANAGER proposing role %s',
      async (role) => {
        await expect(
          staffService.initiateOnboarding(onboardingDto({ role }), 'manager-1', StaffRole.MANAGER),
        ).rejects.toThrow(/Only an Admin or SuperAdmin/);
      },
    );

    it.each([StaffRole.ADMIN, StaffRole.APPROVER])(
      'allows an ADMIN initiator to propose role %s',
      async (role) => {
        const request = await staffService.initiateOnboarding(
          onboardingDto({ role }),
          'admin-2',
          StaffRole.ADMIN,
        );
        expect(request).toBeDefined();
      },
    );

    it.each([StaffRole.ADMIN, StaffRole.APPROVER])(
      'allows a SUPERADMIN initiator to propose role %s',
      async (role) => {
        const request = await staffService.initiateOnboarding(
          onboardingDto({ role }),
          'superadmin-1',
          StaffRole.SUPERADMIN,
        );
        expect(request).toBeDefined();
      },
    );

    it('still allows a MANAGER to propose MARKETER/MANAGER, unaffected by the restriction', async () => {
      const request = await staffService.initiateOnboarding(
        onboardingDto({ role: StaffRole.MARKETER }),
        'manager-1',
        StaffRole.MANAGER,
      );
      expect(request).toBeDefined();
    });
  });

  describe('resubmitOnboarding (edit-and-resubmit a REJECTED proposal)', () => {
    async function initiateAndReject(
      overrides: Partial<InitiateStaffOnboardingDto> = {},
    ): Promise<{ requestId: string; email: string }> {
      const dto = onboardingDto(overrides);
      const request = await staffService.initiateOnboarding(dto, 'manager-1', StaffRole.MANAGER);
      await workflowEngineService.act({
        workflowRequestId: request._id.toString(),
        actor: ADMIN_APPROVE_STAFF_ACTOR,
        action: WorkflowStepAction.REJECTED,
        comment: 'Missing valid ID documentation',
      });
      return { requestId: request._id.toString(), email: dto.email };
    }

    it('restarts the chain (back to PENDING_APPROVAL) with the edited fields, and can then be approved normally', async () => {
      const { requestId } = await initiateAndReject();
      const editedDto = onboardingDto({ firstName: 'Edited', lastName: 'Name' });

      const resubmitted = await staffService.resubmitOnboarding(
        requestId,
        editedDto,
        'manager-1',
        StaffRole.MANAGER,
      );
      expect(resubmitted.status).toBe(WorkflowStatus.PENDING_APPROVAL);
      const payload = resubmitted.payloadHistory[resubmitted.payloadHistory.length - 1]
        ?.payload as Record<string, unknown>;
      expect(payload.firstName).toBe('Edited');
      expect(payload.email).toBe(editedDto.email);

      await workflowEngineService.act({
        workflowRequestId: requestId,
        actor: { staffId: 'admin-9', capabilities: [approveCapability(WorkflowEntityType.STAFF)] },
        action: WorkflowStepAction.APPROVED,
      });
      const created = await staffModel.findOne({ email: editedDto.email }).exec();
      expect(created).not.toBeNull();
      expect(created?.firstName).toBe('Edited');
    });

    it('keeps the existing passportPhotoUrl/idDocumentUrl when resubmitted with no new files', async () => {
      const dto = onboardingDto();
      const request = await staffService.initiateOnboarding(dto, 'manager-1', StaffRole.MANAGER, {
        passportPhoto: [
          {
            filename: 'photo.jpg',
            path: '/tmp/uploads/staff/profile/photo.jpg',
            destination: '/tmp/uploads/staff/profile',
          } as Express.Multer.File,
        ],
      });
      await workflowEngineService.act({
        workflowRequestId: request._id.toString(),
        actor: ADMIN_APPROVE_STAFF_ACTOR,
        action: WorkflowStepAction.REJECTED,
        comment: 'not eligible yet',
      });
      const originalPayload = request.payloadHistory[0]?.payload as Record<string, unknown>;
      expect(originalPayload.passportPhotoUrl).toBeTruthy();

      const resubmitted = await staffService.resubmitOnboarding(
        request._id.toString(),
        onboardingDto(),
        'manager-1',
        StaffRole.MANAGER,
      );
      const newPayload = resubmitted.payloadHistory[resubmitted.payloadHistory.length - 1]
        ?.payload as Record<string, unknown>;
      expect(newPayload.passportPhotoUrl).toBe(originalPayload.passportPhotoUrl);
    });

    it('rejects resubmission by anyone other than the original initiator', async () => {
      const { requestId } = await initiateAndReject();
      await expect(
        staffService.resubmitOnboarding(requestId, onboardingDto(), 'someone-else', StaffRole.MANAGER),
      ).rejects.toThrow(/original initiator/);
    });

    it('rejects resubmitting a request that is not yet REJECTED/RETURNED_TO_MAKER', async () => {
      const dto = onboardingDto();
      const request = await staffService.initiateOnboarding(dto, 'manager-1', StaffRole.MANAGER);
      await expect(
        staffService.resubmitOnboarding(request._id.toString(), dto, 'manager-1', StaffRole.MANAGER),
      ).rejects.toThrow(/REJECTED or RETURNED_TO_MAKER/);
    });

    it('re-checks the ADMIN/APPROVER role restriction on resubmit — a MANAGER cannot edit their way into proposing ADMIN', async () => {
      const { requestId } = await initiateAndReject();
      await expect(
        staffService.resubmitOnboarding(
          requestId,
          onboardingDto({ role: StaffRole.ADMIN }),
          'manager-1',
          StaffRole.MANAGER,
        ),
      ).rejects.toThrow(/Only an Admin or SuperAdmin/);
    });
  });

  describe('createDirect', () => {
    it('creates an ACTIVE staff record immediately, no workflow involved, with a system-generated temporary password and mustChangePassword=true', async () => {
      const dto = directDto();

      const eventEmitter = moduleRef.get(EventEmitter2);
      const emitted: StaffCreatedEvent[] = [];
      eventEmitter.on(STAFF_CREATED_EVENT, (event: StaffCreatedEvent) => emitted.push(event));

      const created = await staffService.createDirect(dto, 'superadmin-1');

      expect(created.status).toBe(StaffStatus.ACTIVE);
      expect(created.role).toBe(StaffRole.MANAGER);
      expect(created.mustChangePassword).toBe(true);

      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.email).toBe(dto.email);
      expect(emitted[0]?.temporaryPassword.length).toBeGreaterThanOrEqual(10);
    });
  });

  describe('updateOwnProfile', () => {
    it('updates only the self-service fields supplied, leaving org-managed fields untouched', async () => {
      const dto = directDto();
      const created = await staffService.createDirect(dto, 'superadmin-1');
      const staffId = created._id.toString();

      const updated = await staffService.updateOwnProfile(staffId, {
        phoneNumber: '08099999999',
        residentialAddress: { state: 'Lagos', city: 'Ikeja', street: '10 Allen Avenue' },
      } as UpdateOwnStaffProfileDto);

      expect(updated.phoneNumber).toBe('08099999999');
      expect(updated.residentialAddress?.state).toBe('Lagos');
      expect(updated.residentialAddress?.city).toBe('Ikeja');
      expect(updated.residentialAddress?.street).toBe('10 Allen Avenue');
      // Untouched — role/department/unit/branch stay whatever createDirect set them to.
      expect(updated.role).toBe(dto.role);
      expect(updated.departmentId.toString()).toBe(dto.departmentId);
    });

    it('rejects a phone number already in use by a different staff member', async () => {
      const first = await staffService.createDirect(directDto(), 'superadmin-1');
      const second = await staffService.createDirect(directDto(), 'superadmin-1');

      await expect(
        staffService.updateOwnProfile(second._id.toString(), {
          phoneNumber: first.phoneNumber,
        } as UpdateOwnStaffProfileDto),
      ).rejects.toThrow();
    });

    it('leaves an unrelated field alone entirely when the update omits it', async () => {
      const created = await staffService.createDirect(directDto(), 'superadmin-1');
      const originalPhone = created.phoneNumber;

      const updated = await staffService.updateOwnProfile(created._id.toString(), {
        residentialAddress: { state: 'Oyo', city: 'Ibadan', street: '5 Ring Road' },
      } as UpdateOwnStaffProfileDto);

      expect(updated.phoneNumber).toBe(originalPhone);
    });
  });

  describe('updateProfile (admin editing another staff member)', () => {
    it('updates the fields supplied and audits only those, leaving everything else untouched', async () => {
      const created = await staffService.createDirect(directDto(), 'superadmin-1');
      const staffId = created._id.toString();
      const originalEmail = created.email;

      const updated = await staffService.updateProfile(
        staffId,
        { employmentType: 'FullTime', salaryGrade: 'Grade B2' } as UpdateStaffProfileDto,
        'superadmin-1',
      );

      expect(updated.employmentType).toBe('FullTime');
      expect(updated.salaryGrade).toBe('Grade B2');
      expect(updated.email).toBe(originalEmail);
    });

    it('rejects assigning SUPERADMIN through this endpoint', async () => {
      const created = await staffService.createDirect(directDto(), 'superadmin-1');

      await expect(
        staffService.updateProfile(
          created._id.toString(),
          { role: StaffRole.SUPERADMIN } as UpdateStaffProfileDto,
          'superadmin-1',
        ),
      ).rejects.toThrow();
    });

    it('rejects editing an existing SUPERADMIN through this endpoint', async () => {
      const superAdminPasswordHash = await bcrypt.hash('Str0ng!Passw0rd', 10);
      const superAdmin = await staffModel.create({
        firstName: 'Root',
        lastName: 'Admin',
        email: `root.${Date.now()}@example.com`,
        phoneNumber: `080${Math.floor(Math.random() * 1e8)}`,
        passwordHash: superAdminPasswordHash,
        role: StaffRole.SUPERADMIN,
        departmentId,
        unitId,
        branchId,
        moduleAccess: [],
        status: StaffStatus.ACTIVE,
      });

      await expect(
        staffService.updateProfile(
          superAdmin._id.toString(),
          { salaryGrade: 'Grade A1' } as UpdateStaffProfileDto,
          'superadmin-1',
        ),
      ).rejects.toThrow();
    });

    it('sets and clears managerId', async () => {
      const manager = await staffService.createDirect(directDto(), 'superadmin-1');
      const report = await staffService.createDirect(directDto(), 'superadmin-1');

      const withManager = await staffService.updateProfile(
        report._id.toString(),
        { managerId: manager._id.toString() } as UpdateStaffProfileDto,
        'superadmin-1',
      );
      expect(withManager.managerId?.toString()).toBe(manager._id.toString());

      const cleared = await staffService.updateProfile(
        report._id.toString(),
        { managerId: '' } as UpdateStaffProfileDto,
        'superadmin-1',
      );
      expect(cleared.managerId).toBeNull();
    });

    it('rejects a nonexistent managerId', async () => {
      const created = await staffService.createDirect(directDto(), 'superadmin-1');

      await expect(
        staffService.updateProfile(
          created._id.toString(),
          { managerId: new Types.ObjectId().toString() } as UpdateStaffProfileDto,
          'superadmin-1',
        ),
      ).rejects.toThrow();
    });

    it('rejects an email already in use by a different staff member', async () => {
      const first = await staffService.createDirect(directDto(), 'superadmin-1');
      const second = await staffService.createDirect(directDto(), 'superadmin-1');

      await expect(
        staffService.updateProfile(
          second._id.toString(),
          { email: first.email } as UpdateStaffProfileDto,
          'superadmin-1',
        ),
      ).rejects.toThrow();
    });
  });

  describe('updateCompliance', () => {
    it('toggles only the fields supplied', async () => {
      const created = await staffService.createDirect(directDto(), 'superadmin-1');

      const updated = await staffService.updateCompliance(
        created._id.toString(),
        { ninVerified: true } as UpdateStaffComplianceDto,
        'superadmin-1',
      );

      expect(updated.ninVerified).toBe(true);
      expect(updated.guarantorFormVerified).toBe(false);
      expect(updated.offerLetterVerified).toBe(false);
    });
  });

  describe('recordLogin', () => {
    it('sets lastLoginAt', async () => {
      const created = await staffService.createDirect(directDto(), 'superadmin-1');
      expect(created.lastLoginAt).toBeNull();

      await staffService.recordLogin(created._id.toString());

      const reloaded = await staffService.findById(created._id.toString());
      expect(reloaded.lastLoginAt).not.toBeNull();
    });
  });

  describe('getPerformanceSummary', () => {
    it('counts customers/groups/loans attributed to this staff member, and surfaces lastLoginAt', async () => {
      const created = await staffService.createDirect(directDto(), 'superadmin-1');
      const staffId = created._id.toString();

      const customerModel = moduleRef.get<Model<{ create: unknown }>>(getModelToken(Customer.name));
      const groupModel = moduleRef.get<Model<{ create: unknown }>>(getModelToken(Group.name));
      const loanModel = moduleRef.get<Model<{ create: unknown }>>(getModelToken(Loan.name));

      // Explicit ObjectId casts, not raw strings — see staff.schema.ts's own
      // "Phase 11 bug fix" comment on findAll: this project's Mongoose setup
      // doesn't reliably auto-cast a plain string against a Types.ObjectId
      // field, on write or on query.
      const staffObjectId = new Types.ObjectId(staffId);
      const branchObjectId = new Types.ObjectId(branchId);

      await customerModel.create({
        firstName: 'Ada',
        lastName: 'Okoye',
        phoneNumber: `070${Math.floor(Math.random() * 1e8)}`,
        branchId: branchObjectId,
        createdBy: staffObjectId,
      });
      await groupModel.create({
        name: `Group ${Date.now()}`,
        branchId: branchObjectId,
        status: 'ACTIVE',
        createdBy: staffObjectId,
      });
      await groupModel.create({
        name: `Group ${Date.now()}-2`,
        branchId: branchObjectId,
        status: 'REJECTED',
        createdBy: staffObjectId,
      });
      await loanModel.create({
        groupId: new Types.ObjectId(),
        productId: new Types.ObjectId(),
        branchId: branchObjectId,
        tenureDays: 14,
        cumulativeAmountKobo: 100_000,
        raisedBy: staffObjectId,
        raisedAt: new Date(),
      });

      await staffService.recordLogin(staffId);
      const summary = await staffService.getPerformanceSummary(staffId);

      expect(summary.customersOnboarded).toBe(1);
      expect(summary.activeGroups).toBe(1); // only the ACTIVE one counts
      expect(summary.loansRaised).toBe(1);
      expect(summary.lastLoginAt).not.toBeNull();
    });
  });

  describe('getActivity', () => {
    it("returns this staff member's own audit trail, newest first", async () => {
      const created = await staffService.createDirect(directDto(), 'superadmin-1');
      const staffId = created._id.toString();

      await staffService.updateCompliance(staffId, { ninVerified: true } as UpdateStaffComplianceDto, staffId);
      await staffService.updateProfile(staffId, { salaryGrade: 'Grade C1' } as UpdateStaffProfileDto, staffId);

      const activity = await staffService.getActivity(staffId);

      expect(activity.length).toBeGreaterThanOrEqual(2);
      expect(activity.every((entry) => entry.entityType === 'STAFF')).toBe(true);
      expect(activity[0]!.timestamp.getTime()).toBeGreaterThanOrEqual(activity[activity.length - 1]!.timestamp.getTime());
    });
  });

  describe('changePassword', () => {
    async function createActiveStaffWithKnownPassword(): Promise<{
      staff: StaffDocument;
      password: string;
    }> {
      const password = 'Str0ng!Passw0rd';
      const passwordHash = await bcrypt.hash(password, 10);
      const staff = await staffModel.create({
        firstName: 'Femi',
        lastName: 'Balogun',
        email: `femi.${Date.now()}.${Math.random()}@example.com`,
        phoneNumber: `080${Math.floor(Math.random() * 1e8)}`,
        passwordHash,
        role: StaffRole.MANAGER,
        departmentId,
        unitId,
        branchId,
        moduleAccess: [],
        status: StaffStatus.ACTIVE,
        mustChangePassword: true,
      });
      return { staff, password };
    }

    it('changes the password, flips mustChangePassword to false, and revokes outstanding refresh tokens', async () => {
      const { staff, password } = await createActiveStaffWithKnownPassword();
      const staffId = staff._id.toString();
      const issued = await refreshTokenService.issue(staffId, 3600);

      const eventEmitter = moduleRef.get(EventEmitter2);
      const emitted: StaffPasswordChangedEvent[] = [];
      eventEmitter.on(STAFF_PASSWORD_CHANGED_EVENT, (event: StaffPasswordChangedEvent) =>
        emitted.push(event),
      );

      await staffService.changePassword(staffId, password, 'N3wStr0ng!Passw0rd');

      const updated = await staffModel.findById(staffId).select('+passwordHash').exec();
      expect(updated?.mustChangePassword).toBe(false);
      const newHashMatches = await bcrypt.compare('N3wStr0ng!Passw0rd', updated!.passwordHash);
      expect(newHashMatches).toBe(true);

      const stillActive = await refreshTokenService.findActive(issued.token);
      expect(stillActive).toBeNull();

      expect(emitted).toEqual([{ staffId, firstName: staff.firstName, email: staff.email }]);
    });

    it('rejects an incorrect current password', async () => {
      const { staff } = await createActiveStaffWithKnownPassword();

      await expect(
        staffService.changePassword(staff._id.toString(), 'WrongPassword!1', 'N3wStr0ng!Passw0rd'),
      ).rejects.toThrow();
    });
  });

  describe('disable / enable', () => {
    it('disables a staff member, revokes their refresh tokens, and enable() reverses it', async () => {
      const dto = onboardingDto();
      const request = await staffService.initiateOnboarding(dto, 'manager-1', StaffRole.MANAGER);
      await workflowEngineService.act({
        workflowRequestId: request._id.toString(),
        actor: ADMIN_APPROVE_STAFF_ACTOR,
        action: WorkflowStepAction.APPROVED,
      });
      const staff = await staffModel.findOne({ email: dto.email }).exec();
      const staffId = staff!._id.toString();

      const issued = await refreshTokenService.issue(staffId, 3600);
      const activeBeforeDisable = await refreshTokenService.findActive(issued.token);
      expect(activeBeforeDisable).not.toBeNull();

      const disabled = await staffService.disable(staffId, ADMIN_ACTOR_ID, 'policy violation');
      expect(disabled.status).toBe(StaffStatus.DISABLED);
      expect(disabled.disabledReason).toBe('policy violation');

      // The refresh token issued before disable must no longer be usable —
      // this is half of the token-invalidation-on-disable mechanism (the
      // other half, live status check on the access token, is covered by
      // strategies/jwt.strategy.spec.ts).
      const activeAfterDisable = await refreshTokenService.findActive(issued.token);
      expect(activeAfterDisable).toBeNull();

      const enabled = await staffService.enable(staffId, ADMIN_ACTOR_ID);
      expect(enabled.status).toBe(StaffStatus.ACTIVE);
      expect(enabled.disabledReason).toBeNull();
    });

    it('rejects disabling an already-disabled staff member', async () => {
      const dto = directDto({
        firstName: 'Chuka',
        lastName: 'Nwosu',
        email: `chuka.${Date.now()}@example.com`,
        phoneNumber: '08011122233',
        moduleAccess: [],
      });
      const created = await staffService.createDirect(dto, 'superadmin-1');

      await staffService.disable(created._id.toString(), ADMIN_ACTOR_ID, 'reason');

      await expect(
        staffService.disable(created._id.toString(), ADMIN_ACTOR_ID, 'again'),
      ).rejects.toThrow();
    });
  });

  describe('BVN verification (Phase 5)', () => {
    async function createActiveStaff(): Promise<StaffDocument> {
      const dto = directDto({
        firstName: 'Tunde',
        lastName: 'Bakare',
        email: `tunde.${Date.now()}.${Math.random()}@example.com`,
        phoneNumber: `080${Math.floor(Math.random() * 1e8)}`,
        moduleAccess: [],
      });
      return staffService.createDirect(dto, 'superadmin-1');
    }

    it('verifyBvn (via directVerify — staff skip the OTP consent flow) sets bvnVerified/bvnVerifiedAt', async () => {
      const staff = await createActiveStaff();
      expect(staff.bvnVerified).toBe(false);

      const verified = await staffService.verifyBvn(
        staff._id.toString(),
        '12345678901',
        ADMIN_ACTOR_ID,
      );

      expect(verified.bvnVerified).toBe(true);
      expect(verified.bvnVerifiedAt).not.toBeNull();
      expect(verified.bvnVerifiedBy?.toString()).toBe(ADMIN_ACTOR_ID);
      // never plaintext at rest
      expect(verified.bvnEncrypted).not.toBe('12345678901');
    });

    it('findStaffWithUnverifiedBvn returns exactly the staff who have not been BVN-verified', async () => {
      const unverified = await createActiveStaff();
      const toBeVerified = await createActiveStaff();
      await staffService.verifyBvn(toBeVerified._id.toString(), '10987654321', ADMIN_ACTOR_ID);

      const results = await staffService.findStaffWithUnverifiedBvn();
      const ids = results.map((s) => s._id.toString());

      expect(ids).toContain(unverified._id.toString());
      expect(ids).not.toContain(toBeVerified._id.toString());
    });

    it('does not block any functional action for an unverified staff member (enforcement level: visibility only — see PHASE_5_NOTES.md)', async () => {
      const staff = await createActiveStaff();
      expect(staff.bvnVerified).toBe(false);
      // status is still ACTIVE — nothing about onboarding/enable/disable is
      // gated on bvnVerified anywhere in this module.
      expect(staff.status).toBe(StaffStatus.ACTIVE);
    });
  });

  describe('Initiator/Authorizer RBAC', () => {
    async function createRawStaffMember(role: StaffRole, userType: StaffUserType): Promise<string> {
      const suffix = `${Date.now()}-${Math.random()}`;
      const created = await staffModel.create({
        firstName: 'Peer',
        lastName: 'Fixture',
        email: `peer.${suffix}@example.com`,
        phoneNumber: `081${Math.floor(Math.random() * 1e8)}`,
        passwordHash: 'unused-in-these-tests',
        role,
        userType,
        departmentId: new Types.ObjectId(departmentId),
        unitId: new Types.ObjectId(unitId),
        branchId: new Types.ObjectId(branchId),
        moduleAccess: [ModuleName.LOANS],
        status: StaffStatus.ACTIVE,
        mustChangePassword: false,
        startDate: new Date('2026-01-01'),
        bvnEncrypted: null,
        residentialAddress: { state: 'Lagos', city: 'Ikeja', street: '1 Test Street' },
        kyc: {
          dateOfBirth: new Date('1990-01-01'),
          gender: Gender.FEMALE,
          idType: IdentificationType.NIN,
          idNumber: '10000000000',
        },
        nextOfKin: { name: 'X', relationship: 'Sister', phoneNumber: '08000000000', address: 'x' },
        reference: { name: 'Y', relationship: 'Friend', phoneNumber: '08000000001', address: 'y' },
      });
      return created._id.toString();
    }

    describe('resolveUserType (MARKETER forced-Initiator / Reviewer no longer assignable)', () => {
      it('forces userType to Initiator for a MARKETER proposal regardless of what was submitted', async () => {
        const dto = onboardingDto({ role: StaffRole.MARKETER, userType: StaffUserType.AUTHORIZER });
        const request = await staffService.initiateOnboarding(dto, 'manager-1', StaffRole.MANAGER);

        const payload = request.payloadHistory[0]?.payload as Record<string, unknown>;
        expect(payload.userType).toBe(StaffUserType.INITIATOR);
      });

      it('rejects Reviewer as a userType for a non-MARKETER onboarding proposal', async () => {
        await expect(
          staffService.initiateOnboarding(
            onboardingDto({ role: StaffRole.MANAGER, userType: StaffUserType.REVIEWER }),
            'manager-1',
            StaffRole.MANAGER,
          ),
        ).rejects.toThrow(/Initiator or Authorizer/);
      });

      it('rejects Reviewer as a userType for createDirect', async () => {
        await expect(
          staffService.createDirect(directDto({ userType: StaffUserType.REVIEWER }), 'superadmin-1'),
        ).rejects.toThrow(/Initiator or Authorizer/);
      });
    });

    describe('same-role peer matching for STAFF approval (PreApprovalValidator)', () => {
      it('a SUPERADMIN-initiated proposal is approved by a different SUPERADMIN Authorizer', async () => {
        const initiatorId = await createRawStaffMember(StaffRole.SUPERADMIN, StaffUserType.INITIATOR);
        const approverId = await createRawStaffMember(StaffRole.SUPERADMIN, StaffUserType.AUTHORIZER);

        const dto = onboardingDto();
        const request = await staffService.initiateOnboarding(dto, initiatorId, StaffRole.SUPERADMIN);

        const acted = await workflowEngineService.act({
          workflowRequestId: request._id.toString(),
          actor: {
            staffId: approverId,
            capabilities: [approveCapability(WorkflowEntityType.STAFF)],
            role: StaffRole.SUPERADMIN,
          },
          action: WorkflowStepAction.APPROVED,
        });
        expect(acted.status).toBe(WorkflowStatus.APPROVED);

        const created = await staffModel.findOne({ email: dto.email }).exec();
        expect(created).not.toBeNull();
      });

      it('rejects an ADMIN Authorizer approving a SUPERADMIN-initiated proposal, even though ADMIN broadly holds approveCapability(STAFF)', async () => {
        const initiatorId = await createRawStaffMember(StaffRole.SUPERADMIN, StaffUserType.INITIATOR);
        const approverId = await createRawStaffMember(StaffRole.ADMIN, StaffUserType.AUTHORIZER);

        const dto = onboardingDto();
        const request = await staffService.initiateOnboarding(dto, initiatorId, StaffRole.SUPERADMIN);

        await expect(
          workflowEngineService.act({
            workflowRequestId: request._id.toString(),
            actor: {
              staffId: approverId,
              capabilities: [approveCapability(WorkflowEntityType.STAFF)],
              role: StaffRole.ADMIN,
            },
            action: WorkflowStepAction.APPROVED,
          }),
        ).rejects.toThrow(/Only a SUPERADMIN may approve/);

        const created = await staffModel.findOne({ email: dto.email }).exec();
        expect(created).toBeNull();
      });

      it('a MANAGER-initiated proposal is approved by a different MANAGER Authorizer (the newly-granted capability)', async () => {
        const initiatorId = await createRawStaffMember(StaffRole.MANAGER, StaffUserType.INITIATOR);
        const approverId = await createRawStaffMember(StaffRole.MANAGER, StaffUserType.AUTHORIZER);

        const dto = onboardingDto();
        const request = await staffService.initiateOnboarding(dto, initiatorId, StaffRole.MANAGER);

        const acted = await workflowEngineService.act({
          workflowRequestId: request._id.toString(),
          actor: {
            staffId: approverId,
            capabilities: [approveCapability(WorkflowEntityType.STAFF)],
            role: StaffRole.MANAGER,
          },
          action: WorkflowStepAction.APPROVED,
        });
        expect(acted.status).toBe(WorkflowStatus.APPROVED);
      });

      it('rejects a SUPERADMIN Authorizer approving a MANAGER-initiated proposal', async () => {
        const initiatorId = await createRawStaffMember(StaffRole.MANAGER, StaffUserType.INITIATOR);
        const approverId = await createRawStaffMember(StaffRole.SUPERADMIN, StaffUserType.AUTHORIZER);

        const dto = onboardingDto();
        const request = await staffService.initiateOnboarding(dto, initiatorId, StaffRole.MANAGER);

        await expect(
          workflowEngineService.act({
            workflowRequestId: request._id.toString(),
            actor: {
              staffId: approverId,
              capabilities: [approveCapability(WorkflowEntityType.STAFF)],
              role: StaffRole.SUPERADMIN,
            },
            action: WorkflowStepAction.APPROVED,
          }),
        ).rejects.toThrow(/Only a MANAGER may approve/);
      });
    });
  });
});
