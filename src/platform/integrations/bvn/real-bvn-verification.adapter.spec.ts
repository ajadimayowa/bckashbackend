import { randomBytes } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model } from 'mongoose';

import { __resetPiiEncryptionKeyCache } from '../../../common/crypto/pii-encryption';
import { InMemoryMongo } from '../../../test-utils/in-memory-mongo';
import { testBvnConfigModule } from '../../../test-utils/test-bvn-config.module';
import { EncryptionService } from '../../encryption/encryption.service';
import { BvnCallLogService } from './bvn-call-log.service';
import { BvnHttpClient } from './bvn-http-client.service';
import { BvnProviderAuthService } from './bvn-provider-auth.service';
import { BvnInvalidException } from './exceptions/bvn-invalid.exception';
import { BvnProviderUnavailableException } from './exceptions/bvn-provider-unavailable.exception';
import { RealBvnVerificationAdapter } from './real-bvn-verification.adapter';
import { BvnCallLog, BvnCallLogDocument, BvnCallLogSchema } from './schemas/bvn-call-log.schema';

const LOGIN_RESPONSE = { Authorisation: { auth: 'sig-1', accesscode: 'code-1' } };

function mockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

/** The real BC Kash MFB `POST /identity/get_bvn` shape — see "BC Kash MFB API Integration Documentation". */
function bvnResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    RequestStatus: true,
    ResponseMessage: 'Successful.',
    isBvnValid: true,
    bvnDetails: {
      BVN: '21111111111',
      phoneNumber: '08161749362',
      FirstName: 'MUIDEEN',
      LastName: 'OLADIPUPO',
      OtherNames: 'OLAIDE',
      DOB: '29-Oct-74',
    },
    ...overrides,
  };
}

describe('RealBvnVerificationAdapter', () => {
  const mongo = new InMemoryMongo();
  let moduleRef: TestingModule;
  let adapter: RealBvnVerificationAdapter;
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
      providers: [BvnCallLogService, EncryptionService],
    }).compile();

    callLogModel = moduleRef.get(getModelToken(BvnCallLog.name));
  }, 60_000);

  beforeEach(() => {
    // Fresh instances each test, same reasoning as bvn-provider-auth.service.spec.ts.
    const authService = new BvnProviderAuthService(
      moduleRef.get(ConfigService),
      moduleRef.get(BvnCallLogService),
    );
    const httpClient = new BvnHttpClient(moduleRef.get(ConfigService), authService);
    adapter = new RealBvnVerificationAdapter(httpClient, moduleRef.get(BvnCallLogService));
  });

  afterEach(async () => {
    await mongo.clearAllCollections();
    fetchSpy?.mockRestore();
  });

  afterAll(async () => {
    await moduleRef.close();
    await mongo.stop();
  });

  describe('directVerify', () => {
    it('parses a valid response into BvnDetails, mapping the provider\'s PascalCase fields', async () => {
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(mockResponse(200, LOGIN_RESPONSE))
        .mockResolvedValueOnce(mockResponse(200, bvnResponse()));

      const details = await adapter.directVerify('21111111111');

      expect(details).toEqual({
        bvn: '21111111111',
        firstName: 'MUIDEEN',
        lastName: 'OLADIPUPO',
        otherNames: 'OLAIDE',
        dateOfBirth: '29-Oct-74',
        phoneNumber: '08161749362',
        rawResponse: bvnResponse(),
      });

      const logs = await callLogModel.find({ step: 'DIRECT_VERIFY' }).exec();
      expect(logs).toHaveLength(1);
      expect(logs[0]?.success).toBe(true);
    });

    it('threads calledBy/entityType/entityId through to the BvnCallLog entry', async () => {
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(mockResponse(200, LOGIN_RESPONSE))
        .mockResolvedValueOnce(mockResponse(200, bvnResponse()));

      await adapter.directVerify('21111111111', {
        calledBy: 'staff-1',
        entityType: 'STAFF',
        entityId: 'staff-1',
      });

      const [log] = await callLogModel.find({ step: 'DIRECT_VERIFY' }).exec();
      expect(log?.calledBy).toBe('staff-1');
      expect(log?.calledForEntityType).toBe('STAFF');
      expect(log?.calledForEntityId).toBe('staff-1');
    });

    it('throws BvnInvalidException (not BvnProviderUnavailableException) when the request succeeds but isBvnValid is false', async () => {
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(mockResponse(200, LOGIN_RESPONSE))
        .mockResolvedValueOnce(
          mockResponse(200, bvnResponse({ isBvnValid: false, ResponseMessage: 'BVN not found', bvnDetails: undefined })),
        );

      await expect(adapter.directVerify('00000000000')).rejects.toThrow(BvnInvalidException);

      const logs = await callLogModel.find({ step: 'DIRECT_VERIFY' }).exec();
      expect(logs).toHaveLength(1);
      expect(logs[0]?.success).toBe(false);
    });

    it('throws BvnProviderUnavailableException when RequestStatus is false', async () => {
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(mockResponse(200, LOGIN_RESPONSE))
        .mockResolvedValueOnce(mockResponse(200, { RequestStatus: false, ResponseMessage: 'Service error' }));

      await expect(adapter.directVerify('12345678901')).rejects.toThrow(BvnProviderUnavailableException);
    });

    it('throws BvnProviderUnavailableException with the HTTP status in its message on a non-2xx response — this is the real 404 the wrong endpoint path used to return', async () => {
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(mockResponse(200, LOGIN_RESPONSE))
        .mockResolvedValueOnce(mockResponse(404, { error: 'Not Found' }));

      await expect(adapter.directVerify('12345678901')).rejects.toThrow(/HTTP 404/);
    });
  });
});
