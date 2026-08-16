import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model, Types } from 'mongoose';

import { InMemoryMongo } from '../../test-utils/in-memory-mongo';
import { DepartmentsService } from './departments.service';
import { Department, DepartmentDocument, DepartmentSchema } from './schemas/department.schema';
import { Unit, UnitDocument, UnitSchema } from './schemas/unit.schema';
import { UnitsService } from './units.service';

describe('UnitsService', () => {
  const mongo = new InMemoryMongo();
  let moduleRef: TestingModule;
  let unitsService: UnitsService;
  let departmentModel: Model<DepartmentDocument>;
  let unitModel: Model<UnitDocument>;

  beforeAll(async () => {
    await mongo.start();
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri()),
        MongooseModule.forFeature([
          { name: Department.name, schema: DepartmentSchema },
          { name: Unit.name, schema: UnitSchema },
        ]),
      ],
      providers: [DepartmentsService, UnitsService],
    }).compile();

    unitsService = moduleRef.get(UnitsService);
    departmentModel = moduleRef.get(getModelToken(Department.name));
    unitModel = moduleRef.get(getModelToken(Unit.name));
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
});
