import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model, Types } from 'mongoose';

import { StaffRole, StaffStatus } from '../../../common/enums/identity.enums';
import { InMemoryMongo } from '../../../test-utils/in-memory-mongo';
import { Staff, StaffDocument, StaffSchema } from '../schemas/staff.schema';
import { StaffResponseDto } from './staff-response.dto';

describe('StaffResponseDto', () => {
  const mongo = new InMemoryMongo();
  let moduleRef: TestingModule;
  let staffModel: Model<StaffDocument>;

  beforeAll(async () => {
    await mongo.start();
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri()),
        MongooseModule.forFeature([{ name: Staff.name, schema: StaffSchema }]),
      ],
    }).compile();
    staffModel = moduleRef.get(getModelToken(Staff.name));
  }, 60_000);

  afterEach(async () => {
    await mongo.clearAllCollections();
  });

  afterAll(async () => {
    await moduleRef.close();
    await mongo.stop();
  });

  it('defense #1: a default (non-selecting) query never returns passwordHash at all', async () => {
    await staffModel.create({
      firstName: 'Ada',
      lastName: 'Okoye',
      email: 'ada@example.com',
      phoneNumber: '08012345678',
      passwordHash: 'super-secret-bcrypt-hash',
      role: StaffRole.MARKETER,
      departmentId: new Types.ObjectId(),
      unitId: new Types.ObjectId(),
      branchId: new Types.ObjectId(),
      moduleAccess: [],
      status: StaffStatus.ACTIVE,
    });

    const found = await staffModel.findOne({ email: 'ada@example.com' }).exec();

    expect(found?.passwordHash).toBeUndefined();
  });

  it('defense #2: even when a query deliberately re-selects passwordHash, the response DTO never includes it', async () => {
    const created = await staffModel.create({
      firstName: 'Ada',
      lastName: 'Okoye',
      email: 'ada2@example.com',
      phoneNumber: '08012345679',
      passwordHash: 'super-secret-bcrypt-hash',
      role: StaffRole.MARKETER,
      departmentId: new Types.ObjectId(),
      unitId: new Types.ObjectId(),
      branchId: new Types.ObjectId(),
      moduleAccess: [],
      status: StaffStatus.ACTIVE,
    });

    // Simulate the one place in the codebase that deliberately opts back in
    // (AuthService, for password comparison at login).
    const withPassword = await staffModel.findById(created._id).select('+passwordHash').exec();
    expect(withPassword?.passwordHash).toBe('super-secret-bcrypt-hash'); // sanity check the select worked

    const dto = StaffResponseDto.fromDocument(withPassword!);
    const serialized = JSON.stringify(dto);

    expect(Object.keys(dto)).not.toContain('passwordHash');
    expect(serialized).not.toContain('passwordHash');
    expect(serialized).not.toContain('super-secret-bcrypt-hash');
  });
});
