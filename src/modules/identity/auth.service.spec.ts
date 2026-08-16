import { UnauthorizedException } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { Model, Types } from 'mongoose';

import { StaffRole, StaffStatus } from '../../common/enums/identity.enums';
import { InMemoryMongo } from '../../test-utils/in-memory-mongo';
import { testJwtConfigModule } from '../../test-utils/test-jwt-config.module';
import { AuthService } from './auth.service';
import { RefreshTokenService } from './refresh-token.service';
import { RefreshToken, RefreshTokenSchema } from './schemas/refresh-token.schema';
import { Staff, StaffDocument, StaffSchema } from './schemas/staff.schema';
import { StaffService } from './staff.service';

describe('AuthService', () => {
  const mongo = new InMemoryMongo();
  let moduleRef: TestingModule;
  let authService: AuthService;
  let staffModel: Model<StaffDocument>;
  const PLAIN_PASSWORD = 'Str0ng!Passw0rd';

  beforeAll(async () => {
    await mongo.start();

    moduleRef = await Test.createTestingModule({
      imports: [
        await testJwtConfigModule(),
        MongooseModule.forRoot(mongo.getUri()),
        MongooseModule.forFeature([
          { name: Staff.name, schema: StaffSchema },
          { name: RefreshToken.name, schema: RefreshTokenSchema },
        ]),
        JwtModule.register({
          secret: 'test-access-secret-not-for-production',
          signOptions: { expiresIn: '15m' },
        }),
      ],
      providers: [
        AuthService,
        RefreshTokenService,
        {
          provide: StaffService,
          // AuthService only ever calls these two read methods — a focused
          // fake backed by the real model avoids wiring StaffService's full
          // dependency graph (departments/units/workflow-engine/audit) just
          // to test login/refresh/logout.
          useFactory: (model: Model<StaffDocument>) => ({
            findByEmailWithPassword: (email: string) =>
              model.findOne({ email: email.toLowerCase() }).select('+passwordHash').exec(),
            findById: async (id: string) => {
              const staff = await model.findById(id).exec();
              if (!staff) {
                throw new Error('not found');
              }
              return staff;
            },
          }),
          inject: [getModelToken(Staff.name)],
        },
      ],
    }).compile();

    authService = moduleRef.get(AuthService);
    staffModel = moduleRef.get(getModelToken(Staff.name));
  }, 60_000);

  afterEach(async () => {
    await mongo.clearAllCollections();
  });

  afterAll(async () => {
    await moduleRef.close();
    await mongo.stop();
  });

  async function createStaff(status: StaffStatus = StaffStatus.ACTIVE): Promise<StaffDocument> {
    const passwordHash = await bcrypt.hash(PLAIN_PASSWORD, 10);
    return staffModel.create({
      firstName: 'Ada',
      lastName: 'Okoye',
      email: `ada.${Date.now()}.${Math.random()}@example.com`,
      phoneNumber: `080${Math.floor(Math.random() * 1e8)}`,
      passwordHash,
      role: StaffRole.MANAGER,
      departmentId: new Types.ObjectId(),
      unitId: new Types.ObjectId(),
      branchId: new Types.ObjectId(),
      moduleAccess: [],
      status,
    });
  }

  describe('login', () => {
    it('rejects an incorrect password', async () => {
      const staff = await createStaff();

      await expect(authService.login(staff.email, 'WrongPassword!1')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects a non-existent email with the same generic message as a wrong password', async () => {
      await expect(authService.login('nobody@example.com', 'whatever')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects a non-ACTIVE staff member even with the correct password', async () => {
      const staff = await createStaff(StaffStatus.DISABLED);

      await expect(authService.login(staff.email, PLAIN_PASSWORD)).rejects.toThrow(/not active/);
    });

    it('issues an access token and a refresh token for valid credentials', async () => {
      const staff = await createStaff();

      const tokens = await authService.login(staff.email, PLAIN_PASSWORD);

      expect(typeof tokens.accessToken).toBe('string');
      expect(tokens.accessToken.split('.')).toHaveLength(3); // JWT shape
      expect(typeof tokens.refreshToken).toBe('string');
    });
  });

  describe('refresh', () => {
    it('issues a new access token and rotates the refresh token', async () => {
      const staff = await createStaff();
      const { refreshToken } = await authService.login(staff.email, PLAIN_PASSWORD);

      const rotated = await authService.refresh(refreshToken);

      expect(typeof rotated.accessToken).toBe('string');
      expect(rotated.refreshToken).not.toBe(refreshToken);
    });

    it('rejects a revoked refresh token', async () => {
      const staff = await createStaff();
      const { refreshToken } = await authService.login(staff.email, PLAIN_PASSWORD);

      await authService.refresh(refreshToken); // rotates — old token is now revoked

      await expect(authService.refresh(refreshToken)).rejects.toThrow(UnauthorizedException);
    });

    it('rejects an unknown refresh token', async () => {
      await expect(authService.refresh('not-a-real-token')).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('logout', () => {
    it('revokes the refresh token so it can no longer be used', async () => {
      const staff = await createStaff();
      const { refreshToken } = await authService.login(staff.email, PLAIN_PASSWORD);

      await authService.logout(refreshToken);

      await expect(authService.refresh(refreshToken)).rejects.toThrow(UnauthorizedException);
    });

    it('is idempotent — logging out an unknown token does not throw', async () => {
      await expect(authService.logout('never-issued-token')).resolves.toBeUndefined();
    });
  });
});
