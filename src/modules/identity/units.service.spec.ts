import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model, Types } from 'mongoose';

import { StaffRole, StaffStatus } from '../../common/enums/identity.enums';
import { InMemoryMongo } from '../../test-utils/in-memory-mongo';
import { DepartmentsService } from './departments.service';
import { Department, DepartmentDocument, DepartmentSchema } from './schemas/department.schema';
import { Staff, StaffDocument, StaffSchema } from './schemas/staff.schema';
import { Unit, UnitDocument, UnitSchema } from './schemas/unit.schema';
import { UnitsService } from './units.service';

describe('UnitsService', () => {
  const mongo = new InMemoryMongo();
  let moduleRef: TestingModule;
  let unitsService: UnitsService;
  let departmentsService: DepartmentsService;
  let departmentModel: Model<DepartmentDocument>;
  let unitModel: Model<UnitDocument>;
  let staffModel: Model<StaffDocument>;

  // Explicit Types.ObjectId casts on departmentId/unitId — same recurring
  // bug class documented throughout this codebase (BranchFundBalanceService,
  // staff.service.ts, BranchFundingService.findAll, ...): a plain string
  // does not reliably cast against a Types.ObjectId-typed schema path in
  // this project's Mongoose setup, including on `.create()` here (empirically
  // confirmed — .create() silently stored a String, not an ObjectId).
  async function createStaff(overrides: Partial<{ departmentId: string; unitId: string }> = {}) {
    return staffModel.create({
      firstName: 'A',
      lastName: 'B',
      email: `staff.${Date.now()}.${Math.random()}@example.com`,
      phoneNumber: `080${Math.floor(Math.random() * 1e8)}`,
      passwordHash: 'hashed',
      role: StaffRole.MARKETER,
      departmentId: overrides.departmentId ? new Types.ObjectId(overrides.departmentId) : new Types.ObjectId(),
      unitId: overrides.unitId ? new Types.ObjectId(overrides.unitId) : new Types.ObjectId(),
      branchId: new Types.ObjectId(),
      moduleAccess: [],
      status: StaffStatus.ACTIVE,
    });
  }

  beforeAll(async () => {
    await mongo.start();
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri()),
        MongooseModule.forFeature([
          { name: Department.name, schema: DepartmentSchema },
          { name: Unit.name, schema: UnitSchema },
          { name: Staff.name, schema: StaffSchema },
        ]),
      ],
      providers: [DepartmentsService, UnitsService],
    }).compile();

    unitsService = moduleRef.get(UnitsService);
    departmentsService = moduleRef.get(DepartmentsService);
    departmentModel = moduleRef.get(getModelToken(Department.name));
    unitModel = moduleRef.get(getModelToken(Unit.name));
    staffModel = moduleRef.get(getModelToken(Staff.name));
  }, 60_000);

  afterEach(async () => {
    await mongo.clearAllCollections();
  });

  afterAll(async () => {
    await moduleRef.close();
    await mongo.stop();
  });

  describe('create', () => {
    it('rejects a unit referencing a non-existent department', async () => {
      await expect(
        unitsService.create({ departmentId: new Types.ObjectId().toString(), name: 'Ops' }),
      ).rejects.toThrow(/does not exist/);
    });

    it('creates a unit under a real department', async () => {
      const department = await departmentModel.create({ name: 'Lending', active: true });

      const unit = await unitsService.create({
        departmentId: department._id.toString(),
        name: 'Ops',
      });

      expect(unit.departmentId.toString()).toBe(department._id.toString());
    });

    it('enforces unique unit names within the same department at the DB level', async () => {
      const department = await departmentModel.create({ name: 'Lending', active: true });
      await unitModel.create({ departmentId: department._id, name: 'Ops', active: true });

      await expect(
        unitModel.create({ departmentId: department._id, name: 'Ops', active: true }),
      ).rejects.toThrow(/duplicate key/);
    });
  });

  describe('assertBelongsToDepartment', () => {
    it('throws when the unit does not belong to the claimed department', async () => {
      const departmentA = await departmentModel.create({ name: 'Lending', active: true });
      const departmentB = await departmentModel.create({ name: 'Ops', active: true });
      const unit = await unitModel.create({
        departmentId: departmentA._id,
        name: 'Team 1',
        active: true,
      });

      await expect(
        unitsService.assertBelongsToDepartment(unit._id.toString(), departmentB._id.toString()),
      ).rejects.toThrow(/does not belong to/);
    });

    it('passes silently when the unit does belong to the claimed department', async () => {
      const department = await departmentModel.create({ name: 'Lending', active: true });
      const unit = await unitModel.create({
        departmentId: department._id,
        name: 'Team 1',
        active: true,
      });

      await expect(
        unitsService.assertBelongsToDepartment(unit._id.toString(), department._id.toString()),
      ).resolves.toBeUndefined();
    });
  });

  describe('UnitsService.remove', () => {
    it('deletes a unit with no staff referencing it', async () => {
      const department = await departmentModel.create({ name: 'Lending', active: true });
      const unit = await unitModel.create({ departmentId: department._id, name: 'Ops', active: true });

      await unitsService.remove(unit._id.toString());

      await expect(unitModel.findById(unit._id).exec()).resolves.toBeNull();
    });

    it('rejects deleting a unit that still has staff referencing it', async () => {
      const department = await departmentModel.create({ name: 'Lending', active: true });
      const unit = await unitModel.create({ departmentId: department._id, name: 'Ops', active: true });
      await createStaff({ departmentId: department._id.toString(), unitId: unit._id.toString() });

      await expect(unitsService.remove(unit._id.toString())).rejects.toThrow(/staff record/);
      await expect(unitModel.findById(unit._id).exec()).resolves.not.toBeNull();
    });

    // Regression coverage for a real bug found while building this: a plain
    // string passed to `.create()` does NOT reliably cast against a
    // Types.ObjectId-typed schema path in this project's Mongoose setup —
    // confirmed by staffModel.create() itself silently storing `unitId` as a
    // bare string when not explicitly cast (see
    // StaffService.handleWorkflowApproved/createDirect's own fix). Any Staff
    // record written before that fix would have a String, not an ObjectId,
    // in the database — countStaffByUnit's `$toString` matching must still
    // count it correctly, with no data migration required.
    it('counts a legacy Staff record whose unitId was stored as a bare string, not an ObjectId', async () => {
      const department = await departmentModel.create({ name: 'Lending', active: true });
      const unit = await unitModel.create({ departmentId: department._id, name: 'Ops', active: true });
      await staffModel.create({
        firstName: 'Legacy',
        lastName: 'Staff',
        email: `legacy.${Date.now()}@example.com`,
        phoneNumber: `0801${Date.now()}`.slice(0, 11),
        passwordHash: 'hashed',
        role: StaffRole.MARKETER,
        // Deliberately NOT cast — reproduces the pre-fix bug directly.
        departmentId: department._id.toString(),
        unitId: unit._id.toString(),
        branchId: new Types.ObjectId(),
        moduleAccess: [],
        status: StaffStatus.ACTIVE,
      });

      const counts = await unitsService.countStaffByUnit([unit._id.toString()]);
      expect(counts.get(unit._id.toString())).toBe(1);

      await expect(unitsService.remove(unit._id.toString())).rejects.toThrow(/staff record/);
    });

    it('throws NotFoundException for a non-existent unit', async () => {
      await expect(unitsService.remove(new Types.ObjectId().toString())).rejects.toThrow(/not found/);
    });
  });

  describe('DepartmentsService.remove', () => {
    it('deletes a department with no units or staff referencing it', async () => {
      const department = await departmentModel.create({ name: 'Lending', active: true });

      await departmentsService.remove(department._id.toString());

      await expect(departmentModel.findById(department._id).exec()).resolves.toBeNull();
    });

    it('rejects deleting a department that still has a unit referencing it', async () => {
      const department = await departmentModel.create({ name: 'Lending', active: true });
      await unitModel.create({ departmentId: department._id, name: 'Ops', active: true });

      await expect(departmentsService.remove(department._id.toString())).rejects.toThrow(
        /still has records referencing it/,
      );
      await expect(departmentModel.findById(department._id).exec()).resolves.not.toBeNull();
    });

    it('rejects deleting a department that still has staff referencing it', async () => {
      const department = await departmentModel.create({ name: 'Lending', active: true });
      await createStaff({ departmentId: department._id.toString() });

      await expect(departmentsService.remove(department._id.toString())).rejects.toThrow(
        /still has records referencing it/,
      );
    });

    // Same regression class as UnitsService.remove's own "legacy" test above.
    it('counts a legacy Staff record whose departmentId was stored as a bare string, not an ObjectId', async () => {
      const department = await departmentModel.create({ name: 'Lending', active: true });
      await staffModel.create({
        firstName: 'Legacy',
        lastName: 'Staff',
        email: `legacy.${Date.now()}@example.com`,
        phoneNumber: `0801${Date.now()}`.slice(0, 11),
        passwordHash: 'hashed',
        role: StaffRole.MARKETER,
        // Deliberately NOT cast — reproduces the pre-fix bug directly.
        departmentId: department._id.toString(),
        unitId: new Types.ObjectId(),
        branchId: new Types.ObjectId(),
        moduleAccess: [],
        status: StaffStatus.ACTIVE,
      });

      expect(await departmentsService.countStaff(department._id.toString())).toBe(1);
      await expect(departmentsService.remove(department._id.toString())).rejects.toThrow(
        /still has records referencing it/,
      );
    });

    // Same regression class — a Unit whose departmentId predates
    // UnitsService.create's explicit-cast fix must still block the
    // department it references from being deleted.
    it('blocks deleting a department that still has a unit whose departmentId was stored as a bare string', async () => {
      const department = await departmentModel.create({ name: 'Lending', active: true });
      await unitModel.create({
        // Deliberately NOT cast — reproduces the pre-fix UnitsService.create bug directly.
        departmentId: department._id.toString() as unknown as Types.ObjectId,
        name: 'Ops',
        active: true,
      });

      await expect(departmentsService.remove(department._id.toString())).rejects.toThrow(
        /still has records referencing it/,
      );
    });
  });
});
