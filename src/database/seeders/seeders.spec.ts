import { EventEmitterModule } from '@nestjs/event-emitter';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Model } from 'mongoose';

import { AuditModule } from '../../platform/audit/audit.module';
import {
  WorkflowChainConfig,
  WorkflowChainConfigSchema,
} from '../../platform/workflow-engine/schemas/workflow-chain-config.schema';
import { WorkflowRequest, WorkflowRequestSchema } from '../../platform/workflow-engine/schemas/workflow-request.schema';
import { WorkflowEngineService } from '../../platform/workflow-engine/workflow-engine.service';
import { BranchesService } from '../../modules/branches/branches.service';
import { Branch, BranchSchema } from '../../modules/branches/schemas/branch.schema';
import { DepartmentsService } from '../../modules/identity/departments.service';
import {
  Department,
  DepartmentDocument,
  DepartmentSchema,
} from '../../modules/identity/schemas/department.schema';
import { Staff, StaffDocument, StaffSchema } from '../../modules/identity/schemas/staff.schema';
import { Unit, UnitSchema } from '../../modules/identity/schemas/unit.schema';
import { UnitsService } from '../../modules/identity/units.service';
import { LeaveType, LeaveTypeSchema } from '../../modules/hr/schemas/leave-type.schema';
import { LeaveTypeService } from '../../modules/hr/leave-type.service';
import { Loan, LoanSchema } from '../../modules/loans/schemas/loan.schema';
import { InMemoryMongo } from '../../test-utils/in-memory-mongo';
import { seedDefaultLeaveTypes } from './leave-types.seeder';
import { seedOrgStructure } from './org-structure.seeder';
import { seedSuperAdmin } from './super-admin.seeder';

describe('seeders', () => {
  const mongo = new InMemoryMongo();
  let moduleRef: TestingModule;
  let staffModel: Model<StaffDocument>;

  function testConfigModule(seedOverrides: Record<string, unknown> = {}) {
    return ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: true,
      load: [
        () => ({
          seed: {
            superAdminFirstName: 'Super',
            superAdminLastName: 'Admin',
            superAdminPhoneNumber: '08000000000',
            ...seedOverrides,
          },
        }),
      ],
    });
  }

  beforeAll(async () => {
    await mongo.start();
  }, 60_000);

  afterEach(async () => {
    await mongo.clearAllCollections();
    await moduleRef?.close();
  });

  afterAll(async () => {
    await mongo.stop();
  });

  async function buildModule(seedOverrides: Record<string, unknown> = {}) {
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri()),
        MongooseModule.forFeature([
          { name: Department.name, schema: DepartmentSchema },
          { name: Unit.name, schema: UnitSchema },
          { name: Branch.name, schema: BranchSchema },
          { name: Staff.name, schema: StaffSchema },
          { name: Loan.name, schema: LoanSchema },
          { name: LeaveType.name, schema: LeaveTypeSchema },
          { name: WorkflowChainConfig.name, schema: WorkflowChainConfigSchema },
          { name: WorkflowRequest.name, schema: WorkflowRequestSchema },
        ]),
        AuditModule,
        // Deliberately NOT importing WorkflowEngineModule itself here — it
        // declares WorkflowRequestsController, which is guarded by
        // StaffContextGuard/RbacService (see that module's own doc comment).
        // Pulling in the whole module (and thus the controller) would force
        // this test module to also stand up RbacModule for no benefit —
        // BranchesService only needs WorkflowEngineService, so it's provided
        // directly here instead, same pattern as branches.service.spec.ts.
        EventEmitterModule.forRoot(),
        testConfigModule(seedOverrides),
      ],
      providers: [DepartmentsService, UnitsService, BranchesService, LeaveTypeService, WorkflowEngineService],
    }).compile();
    staffModel = moduleRef.get(getModelToken(Staff.name));
    return moduleRef;
  }

  describe('seedOrgStructure', () => {
    it('creates a default Department/Unit/Branch when none exist', async () => {
      const app = await buildModule();

      const org = await seedOrgStructure(app);

      expect(org.departmentId).toBeTruthy();
      expect(org.unitId).toBeTruthy();
      expect(org.branchId).toBeTruthy();
      const departmentModel = app.get<Model<DepartmentDocument>>(getModelToken(Department.name));
      expect(await departmentModel.countDocuments({}).exec()).toBe(1);
    });

    it('is idempotent — re-running does not create a second set', async () => {
      const app = await buildModule();

      const first = await seedOrgStructure(app);
      const second = await seedOrgStructure(app);

      expect(second).toEqual(first);
      const departmentModel = app.get<Model<DepartmentDocument>>(getModelToken(Department.name));
      expect(await departmentModel.countDocuments({}).exec()).toBe(1);
    });
  });

  describe('seedSuperAdmin', () => {
    it('throws if SEED_SUPERADMIN_EMAIL/PASSWORD are not set — refuses to guess a default password', async () => {
      const app = await buildModule();
      const org = await seedOrgStructure(app);

      await expect(seedSuperAdmin(app, org)).rejects.toThrow(
        /SEED_SUPERADMIN_EMAIL and SEED_SUPERADMIN_PASSWORD/,
      );
    });

    it('creates a SUPERADMIN staff member with a hashed password', async () => {
      const app = await buildModule({
        superAdminEmail: 'superadmin@bckashcooperative.com',
        superAdminPassword: 'Sup3r$ecurePass!',
      });
      const org = await seedOrgStructure(app);

      await seedSuperAdmin(app, org);

      const created = await staffModel
        .findOne({ email: 'superadmin@bckashcooperative.com' })
        .exec();
      expect(created).not.toBeNull();
      expect(created!.role).toBe('SUPERADMIN');
      expect(created!.status).toBe('ACTIVE');
      expect(created!.passwordHash).not.toBe('Sup3r$ecurePass!');
      expect(created!.moduleAccess).toEqual(expect.arrayContaining(['LOANS', 'ACCOUNTING', 'HR']));
    });

    it('is idempotent — re-running with the same email does not create a duplicate', async () => {
      const app = await buildModule({
        superAdminEmail: 'superadmin@bckashcooperative.com',
        superAdminPassword: 'Sup3r$ecurePass!',
      });
      const org = await seedOrgStructure(app);

      await seedSuperAdmin(app, org);
      await seedSuperAdmin(app, org);

      const count = await staffModel
        .countDocuments({ email: 'superadmin@bckashcooperative.com' })
        .exec();
      expect(count).toBe(1);
    });
  });

  describe('seedDefaultLeaveTypes', () => {
    it('seeds the five default leave types', async () => {
      const app = await buildModule();

      await seedDefaultLeaveTypes(app);

      const leaveTypeService = app.get(LeaveTypeService);
      const all = await leaveTypeService.findAll();
      expect(all.map((t) => t.name).sort()).toEqual(
        ['Annual', 'Casual', 'Maternity/Paternity', 'Sick', 'Unpaid'].sort(),
      );
    });

    it('is idempotent by name — re-running creates no duplicates and preserves an Admin-made edit', async () => {
      const app = await buildModule();
      await seedDefaultLeaveTypes(app);
      const leaveTypeService = app.get(LeaveTypeService);
      const annual = (await leaveTypeService.findAll()).find((t) => t.name === 'Annual')!;
      await leaveTypeService.update(annual._id.toString(), { defaultAnnualAllocationDays: 25 });

      await seedDefaultLeaveTypes(app);

      const all = await leaveTypeService.findAll();
      expect(all).toHaveLength(5);
      const reloaded = all.find((t) => t.name === 'Annual')!;
      expect(reloaded.defaultAnnualAllocationDays).toBe(25); // not overwritten back to 20
    });
  });
});
