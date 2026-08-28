import { GoneException, UnauthorizedException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Types } from 'mongoose';

import { InMemoryMongo } from '../../test-utils/in-memory-mongo';
import { AuthOtpService } from './auth-otp.service';
import { LOGIN_OTP_ISSUED_EVENT, LoginOtpIssuedEvent } from './events/auth-otp.events';
import { LoginOtpChallenge, LoginOtpChallengeSchema } from './schemas/login-otp-challenge.schema';
import { StaffDocument } from './schemas/staff.schema';

function fakeStaff(overrides: Partial<StaffDocument> = {}): StaffDocument {
  return {
    _id: new Types.ObjectId(),
    firstName: 'Ada',
    email: 'ada@example.com',
    phoneNumber: '08012345678',
    ...overrides,
  } as StaffDocument;
}

describe('AuthOtpService', () => {
  const mongo = new InMemoryMongo();
  let moduleRef: TestingModule;
  let service: AuthOtpService;
  let eventEmitter: EventEmitter2;

  beforeAll(async () => {
    await mongo.start();
  }, 60_000);

  afterAll(async () => {
    await mongo.stop();
  });

  async function setup(
    authOtpConfig: Record<string, unknown> = { ttlSeconds: 600, maxAttempts: 5 },
  ) {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ authOtp: authOtpConfig })],
        }),
        EventEmitterModule.forRoot(),
        MongooseModule.forRoot(mongo.getUri()),
        MongooseModule.forFeature([
          { name: LoginOtpChallenge.name, schema: LoginOtpChallengeSchema },
        ]),
      ],
      providers: [AuthOtpService],
    }).compile();
    service = moduleRef.get(AuthOtpService);
    eventEmitter = moduleRef.get(EventEmitter2);
  }

  afterEach(async () => {
    await moduleRef.close();
    await mongo.clearAllCollections();
  });

  it('issues a challenge, emits LOGIN_OTP_ISSUED_EVENT with the plaintext code, and lets that exact code verify successfully', async () => {
    await setup();
    const staff = fakeStaff();
    const events: LoginOtpIssuedEvent[] = [];
    eventEmitter.on(LOGIN_OTP_ISSUED_EVENT, (e: LoginOtpIssuedEvent) => events.push(e));

    const { challengeId, expiresAt } = await service.issueChallenge(staff);

    expect(events).toHaveLength(1);
    expect(events[0]?.staffId).toBe(staff._id.toString());
    expect(events[0]?.code).toMatch(/^\d{6}$/);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

    const staffId = await service.verifyChallenge(challengeId, events[0]!.code);
    expect(staffId).toBe(staff._id.toString());
  });

  it('rejects a wrong code', async () => {
    await setup();
    const staff = fakeStaff();
    const { challengeId } = await service.issueChallenge(staff);

    await expect(service.verifyChallenge(challengeId, '000000')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('is single-use — the same correct code cannot verify twice', async () => {
    await setup();
    const staff = fakeStaff();
    const events: LoginOtpIssuedEvent[] = [];
    eventEmitter.on(LOGIN_OTP_ISSUED_EVENT, (e: LoginOtpIssuedEvent) => events.push(e));
    const { challengeId } = await service.issueChallenge(staff);
    const code = events[0]!.code;

    await service.verifyChallenge(challengeId, code);

    await expect(service.verifyChallenge(challengeId, code)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects an expired challenge', async () => {
    await setup({ ttlSeconds: -1, maxAttempts: 5 }); // already expired the instant it's issued
    const staff = fakeStaff();
    const events: LoginOtpIssuedEvent[] = [];
    eventEmitter.on(LOGIN_OTP_ISSUED_EVENT, (e: LoginOtpIssuedEvent) => events.push(e));
    const { challengeId } = await service.issueChallenge(staff);

    await expect(service.verifyChallenge(challengeId, events[0]!.code)).rejects.toThrow(
      GoneException,
    );
  });

  it('invalidates the challenge after maxAttempts wrong guesses', async () => {
    await setup({ ttlSeconds: 600, maxAttempts: 2 });
    const staff = fakeStaff();
    const { challengeId } = await service.issueChallenge(staff);

    await expect(service.verifyChallenge(challengeId, '000000')).rejects.toThrow(
      UnauthorizedException,
    );
    await expect(service.verifyChallenge(challengeId, '000000')).rejects.toThrow(GoneException);
  });

  it('AUTH_OTP_DEFAULT_CODE, when set, is used verbatim instead of a random code', async () => {
    await setup({ ttlSeconds: 600, maxAttempts: 5, defaultCode: '111111' });
    const staff = fakeStaff();
    const events: LoginOtpIssuedEvent[] = [];
    eventEmitter.on(LOGIN_OTP_ISSUED_EVENT, (e: LoginOtpIssuedEvent) => events.push(e));

    await service.issueChallenge(staff);
    await service.issueChallenge(fakeStaff());

    expect(events.map((e) => e.code)).toEqual(['111111', '111111']);
  });
});
