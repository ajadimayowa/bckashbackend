import { GoneException, UnauthorizedException } from '@nestjs/common';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { JwtModule } from '@nestjs/jwt';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { Model, Types } from 'mongoose';

import { StaffRole, StaffStatus } from '../../common/enums/identity.enums';
import { BvnProviderAuthService } from '../../platform/integrations/bvn/bvn-provider-auth.service';
import { InMemoryMongo } from '../../test-utils/in-memory-mongo';
import { testJwtConfigModule } from '../../test-utils/test-jwt-config.module';
import { AuthOtpService } from './auth-otp.service';
import { AuthService } from './auth.service';
import { LOGIN_OTP_ISSUED_EVENT, LoginOtpIssuedEvent } from './events/auth-otp.events';
import { RefreshTokenService } from './refresh-token.service';
import { LoginOtpChallenge, LoginOtpChallengeSchema } from './schemas/login-otp-challenge.schema';
import { RefreshToken, RefreshTokenSchema } from './schemas/refresh-token.schema';
import { Staff, StaffDocument, StaffSchema } from './schemas/staff.schema';
import { StaffService } from './staff.service';

describe('AuthService', () => {
  const mongo = new InMemoryMongo();
  let moduleRef: TestingModule;
  let authService: AuthService;
  let eventEmitter: EventEmitter2;
  let staffModel: Model<StaffDocument>;
  const PLAIN_PASSWORD = 'Str0ng!Passw0rd';

  beforeAll(async () => {
    await mongo.start();

    moduleRef = await Test.createTestingModule({
      imports: [
        await testJwtConfigModule(),
        EventEmitterModule.forRoot(),
        MongooseModule.forRoot(mongo.getUri()),
        MongooseModule.forFeature([
          { name: Staff.name, schema: StaffSchema },
          { name: RefreshToken.name, schema: RefreshTokenSchema },
          { name: LoginOtpChallenge.name, schema: LoginOtpChallengeSchema },
        ]),
        JwtModule.register({
          secret: 'test-access-secret-not-for-production',
          signOptions: { expiresIn: '15m' },
        }),
      ],
      providers: [
        AuthService,
        AuthOtpService,
        RefreshTokenService,
        {
          provide: StaffService,
          // AuthService only ever calls these methods — a focused fake
          // backed by the real model avoids wiring StaffService's full
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
            // Fire-and-forget in AuthService.verifyLoginOtp — no test asserts against it.
            recordLogin: async () => undefined,
          }),
          inject: [getModelToken(Staff.name)],
        },
        {
          provide: BvnProviderAuthService,
          // Login's BVN pre-warm is fire-and-forget (see AuthService.verifyLoginOtp)
          // — a bare resolved stub is enough, no test asserts against it.
          useValue: { getAuthHeaders: async () => ({}) },
        },
      ],
    }).compile();

    authService = moduleRef.get(AuthService);
    eventEmitter = moduleRef.get(EventEmitter2);
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

  /**
   * Drives the full two-step flow: `login()` for the challenge, capturing
   * the OTP code off `LOGIN_OTP_ISSUED_EVENT` (the same event
   * `NotificationsModule`'s listener consumes in the real app — see
   * auth-otp.events.ts), then `verifyLoginOtp()` for the actual tokens.
   */
  async function loginAndGetTokens(email: string, password: string) {
    const codes: LoginOtpIssuedEvent[] = [];
    const listener = (event: LoginOtpIssuedEvent) => codes.push(event);
    eventEmitter.on(LOGIN_OTP_ISSUED_EVENT, listener);

    const challenge = await authService.login(email, password);
    const code = codes.at(-1)?.code;
    eventEmitter.off(LOGIN_OTP_ISSUED_EVENT, listener);
    if (!code) {
      throw new Error('LOGIN_OTP_ISSUED_EVENT was not emitted');
    }

    return authService.verifyLoginOtp(challenge.challengeId, code);
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

    it('issues an OTP challenge (not tokens) for valid credentials', async () => {
      const staff = await createStaff();

      const challenge = await authService.login(staff.email, PLAIN_PASSWORD);

      expect(typeof challenge.challengeId).toBe('string');
      expect(challenge.expiresAt).toBeInstanceOf(Date);
      expect(challenge).not.toHaveProperty('accessToken');
    });
  });

  describe('verifyLoginOtp', () => {
    it('issues an access token and a refresh token for a correct OTP, plus userDetails for frontend routing', async () => {
      const staff = await createStaff();

      const result = await loginAndGetTokens(staff.email, PLAIN_PASSWORD);

      expect(typeof result.accessToken).toBe('string');
      expect(result.accessToken.split('.')).toHaveLength(3); // JWT shape
      expect(typeof result.refreshToken).toBe('string');
      expect(result.userDetails).toEqual({
        id: staff._id,
        firstName: staff.firstName,
        lastName: staff.lastName,
        userType: 'Reviewer', // StaffRole.MANAGER — see staff-user-type.util.ts
        userLevel: StaffRole.MANAGER,
        mustChangePassword: staff.mustChangePassword,
      });
    });

    it('rejects a wrong code', async () => {
      const staff = await createStaff();
      const challenge = await authService.login(staff.email, PLAIN_PASSWORD);

      await expect(authService.verifyLoginOtp(challenge.challengeId, '000000')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects reusing an already-verified challenge', async () => {
      const staff = await createStaff();
      const codes: LoginOtpIssuedEvent[] = [];
      const listener = (event: LoginOtpIssuedEvent) => codes.push(event);
      eventEmitter.on(LOGIN_OTP_ISSUED_EVENT, listener);
      const challenge = await authService.login(staff.email, PLAIN_PASSWORD);
      const code = codes.at(-1)!.code;
      eventEmitter.off(LOGIN_OTP_ISSUED_EVENT, listener);

      await authService.verifyLoginOtp(challenge.challengeId, code);

      await expect(authService.verifyLoginOtp(challenge.challengeId, code)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects an unknown challengeId', async () => {
      await expect(
        authService.verifyLoginOtp(new Types.ObjectId().toString(), '123456'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('invalidates the challenge after AUTH_OTP_MAX_ATTEMPTS wrong guesses', async () => {
      const staff = await createStaff();
      const challenge = await authService.login(staff.email, PLAIN_PASSWORD);

      // testJwtConfigModule's authOtp.maxAttempts is 5.
      for (let i = 0; i < 4; i++) {
        await expect(authService.verifyLoginOtp(challenge.challengeId, '000000')).rejects.toThrow(
          UnauthorizedException,
        );
      }
      await expect(authService.verifyLoginOtp(challenge.challengeId, '000000')).rejects.toThrow(
        GoneException,
      );
    });
  });

  describe('refresh', () => {
    it('issues a new access token and rotates the refresh token', async () => {
      const staff = await createStaff();
      const { refreshToken } = await loginAndGetTokens(staff.email, PLAIN_PASSWORD);

      const rotated = await authService.refresh(refreshToken);

      expect(typeof rotated.accessToken).toBe('string');
      expect(rotated.refreshToken).not.toBe(refreshToken);
    });

    it('rejects a revoked refresh token', async () => {
      const staff = await createStaff();
      const { refreshToken } = await loginAndGetTokens(staff.email, PLAIN_PASSWORD);

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
      const { refreshToken } = await loginAndGetTokens(staff.email, PLAIN_PASSWORD);

      await authService.logout(refreshToken);

      await expect(authService.refresh(refreshToken)).rejects.toThrow(UnauthorizedException);
    });

    it('is idempotent — logging out an unknown token does not throw', async () => {
      await expect(authService.logout('never-issued-token')).resolves.toBeUndefined();
    });
  });
});
