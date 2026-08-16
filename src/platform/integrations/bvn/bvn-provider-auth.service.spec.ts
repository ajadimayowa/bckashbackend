import { randomBytes } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model } from 'mongoose';

import { __resetPiiEncryptionKeyCache } from '../../../common/crypto/pii-encryption';
import { EncryptionService } from '../../encryption/encryption.service';
import { InMemoryMongo } from '../../../test-utils/in-memory-mongo';
import { testBvnConfigModule } from '../../../test-utils/test-bvn-config.module';
import { BvnCallLogService } from './bvn-call-log.service';
import { BvnProviderAuthService } from './bvn-provider-auth.service';
import { BvnProviderUnavailableException } from './exceptions/bvn-provider-unavailable.exception';
import { BvnCallLog, BvnCallLogDocument, BvnCallLogSchema } from './schemas/bvn-call-log.schema';

describe('BvnProviderAuthService', () => {
  const mongo = new InMemoryMongo();
  let moduleRef: TestingModule;
  let authService: BvnProviderAuthService;
  let callLogModel: Model<BvnCallLogDocument>;
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  beforeAll(async () => {
    process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    __resetPiiEncryptionKeyCache();

    await mongo.start();

    moduleRef = await Test.createTestingModule({
      imports: [
        await testBvnConfigModule(),
        MongooseModule.forRoot(mongo.getUri()),
        MongooseModule.forFeature([{ name: BvnCallLog.name, schema: BvnCallLogSchema }]),
      ],
      providers: [BvnProviderAuthService, BvnCallLogService, EncryptionService],
    }).compile();

    callLogModel = moduleRef.get(getModelToken(BvnCallLog.name));
  }, 60_000);

  beforeEach(() => {
    // A fresh instance per test — BvnProviderAuthService caches its auth
    // headers in an instance field, which would otherwise leak across tests
    // if they shared the module-scoped singleton (Nest DI would give every
    // test the *same* cached-forever instance since it's the same TestingModule).
    authService = new BvnProviderAuthService(
      moduleRef.get(ConfigService),
      moduleRef.get(BvnCallLogService),
    );
  });

  afterEach(async () => {
    await mongo.clearAllCollections();
    fetchSpy?.mockRestore();
  });

  afterAll(async () => {
    await moduleRef.close();
    await mongo.stop();
  });

  function mockFetchOnce(status: number, body: unknown): void {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    } as Response);
  }

  it('logs in and caches the resulting auth headers', async () => {
    mockFetchOnce(200, { Authorisation: { auth: 'sig-1', accesscode: 'code-1' } });

    const headers = await authService.getAuthHeaders();

    expect(headers).toEqual({ 'X-Auth-Signature': 'sig-1', Authorization: 'Bearer code-1' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/initialisation/init'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('does not re-login on a second call once cached', async () => {
    mockFetchOnce(200, { Authorisation: { auth: 'sig-1', accesscode: 'code-1' } });

    await authService.getAuthHeaders();
    await authService.getAuthHeaders();
    await authService.getAuthHeaders();

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('re-authenticates on refresh(), producing a new set of headers', async () => {
    mockFetchOnce(200, { Authorisation: { auth: 'sig-1', accesscode: 'code-1' } });
    await authService.getAuthHeaders();

    mockFetchOnce(200, { Authorisation: { auth: 'sig-2', accesscode: 'code-2' } });
    const refreshed = await authService.refresh();

    expect(refreshed).toEqual({ 'X-Auth-Signature': 'sig-2', Authorization: 'Bearer code-2' });
  });

  it('throws BvnProviderUnavailableException when the login response is rejected', async () => {
    mockFetchOnce(401, { error: true, message: 'bad credentials' });

    await expect(authService.getAuthHeaders()).rejects.toThrow(BvnProviderUnavailableException);
  });

  it('writes a BvnCallLog entry (step AUTH_LOGIN) for both a successful and a failed login', async () => {
    mockFetchOnce(200, { Authorisation: { auth: 'sig-1', accesscode: 'code-1' } });
    await authService.getAuthHeaders();

    mockFetchOnce(500, { error: true, message: 'down' });
    await expect(authService.refresh()).rejects.toThrow();

    const logs = await callLogModel.find({ step: 'AUTH_LOGIN' }).sort({ calledAt: 1 }).exec();
    expect(logs).toHaveLength(2);
    expect(logs[0]?.success).toBe(true);
    expect(logs[1]?.success).toBe(false);
  });
});
