import { EventEmitterModule } from '@nestjs/event-emitter';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model, Types } from 'mongoose';

import { ModuleName, StaffRole, StaffStatus } from '../../common/enums/identity.enums';
import { WorkflowStatus, WorkflowStepAction } from '../../common/enums/workflow.enums';
import { WorkflowEntityType } from '../../common/enums/workflow.enums';
import { AuditModule } from '../../platform/audit/audit.module';
import { approveCapability } from '../../platform/rbac/constants/capabilities';
import { InMemoryMongo } from '../../test-utils/in-memory-mongo';
import { Branch, BranchDocument, BranchSchema } from '../branches/schemas/branch.schema';
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
          { name: WorkflowChainConfig.name, schema: WorkflowChainConfigSchema },
          { name: WorkflowRequest.name, schema: WorkflowRequestSchema },
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

  function onboardingDto(
    overrides: Partial<InitiateStaffOnboardingDto> = {},
  ): InitiateStaffOnboardingDto {
    const dto = new InitiateStaffOnboardingDto();
    dto.firstName = 'Ada';
    dto.lastName = 'Okoye';
    dto.email = `ada.${Date.now()}.${Math.random()}@example.com`;
    dto.phoneNumber = '08012345678';
    dto.password = 'Str0ng!Passw0rd';
    dto.departmentId = departmentId;
    dto.unitId = unitId;
    dto.branchId = branchId;
    dto.moduleAccess = [ModuleName.LOANS];
    return Object.assign(dto, overrides);
  }

  describe('initiateOnboarding', () => {
    it('creates a WorkflowRequest, not a live Staff record', async () => {
      const dto = onboardingDto();

      const request = await staffService.initiateOnboarding(dto, 'manager-1');

      expect(request.status).toBe(WorkflowStatus.PENDING_APPROVAL); // single-step chain
      expect(request.entityType).toBe(WorkflowEntityType.STAFF);

      const staffCount = await staffModel.countDocuments({ email: dto.email });
      expect(staffCount).toBe(0);
    });

    it('never puts the plaintext password in the workflow payload', async () => {
      const dto = onboardingDto();

      const request = await staffService.initiateOnboarding(dto, 'manager-1');

      const payload = request.payloadHistory[0]?.payload as Record<string, unknown>;
      expect(JSON.stringify(payload)).not.toContain(dto.password);
      expect(payload.passwordHash).toBeDefined();
      expect(payload.passwordHash).not.toBe(dto.password);
    });

    it('only appears as an active staff member after approval', async () => {
      const dto = onboardingDto();
      const request = await staffService.initiateOnboarding(dto, 'manager-1');

      await workflowEngineService.act({
        workflowRequestId: request._id.toString(),
        actor: ADMIN_APPROVE_STAFF_ACTOR,
        action: WorkflowStepAction.APPROVED,
      });

      const created = await staffModel.findOne({ email: dto.email }).exec();
      expect(created).not.toBeNull();
      expect(created?.status).toBe(StaffStatus.ACTIVE);
      expect(created?.role).toBe(StaffRole.MARKETER);
    });

    it('a rejected onboarding never creates a Staff record', async () => {
      const dto = onboardingDto();
      const request = await staffService.initiateOnboarding(dto, 'manager-1');

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
        ),
      ).rejects.toThrow();
    });
  });

  describe('createDirect', () => {
    it('creates an ACTIVE staff record immediately, no workflow involved', async () => {
      const dto = new CreateStaffDirectDto();
      dto.firstName = 'Bola';
      dto.lastName = 'Adeyemi';
      dto.email = `bola.${Date.now()}@example.com`;
      dto.phoneNumber = '08087654321';
      dto.password = 'Str0ng!Passw0rd';
      dto.role = StaffRole.MANAGER;
      dto.departmentId = departmentId;
      dto.unitId = unitId;
      dto.branchId = branchId;
      dto.moduleAccess = [ModuleName.LOANS];

      const created = await staffService.createDirect(dto, 'superadmin-1');

      expect(created.status).toBe(StaffStatus.ACTIVE);
      expect(created.role).toBe(StaffRole.MANAGER);
    });
  });

  describe('disable / enable', () => {
    it('disables a staff member, revokes their refresh tokens, and enable() reverses it', async () => {
      const dto = onboardingDto();
      const request = await staffService.initiateOnboarding(dto, 'manager-1');
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
      const dto = new CreateStaffDirectDto();
      dto.firstName = 'Chuka';
      dto.lastName = 'Nwosu';
      dto.email = `chuka.${Date.now()}@example.com`;
      dto.phoneNumber = '08011122233';
      dto.password = 'Str0ng!Passw0rd';
      dto.role = StaffRole.MANAGER;
      dto.departmentId = departmentId;
      dto.unitId = unitId;
      dto.branchId = branchId;
      dto.moduleAccess = [];
      const created = await staffService.createDirect(dto, 'superadmin-1');

      await staffService.disable(created._id.toString(), ADMIN_ACTOR_ID, 'reason');

      await expect(
        staffService.disable(created._id.toString(), ADMIN_ACTOR_ID, 'again'),
      ).rejects.toThrow();
    });
  });
});
