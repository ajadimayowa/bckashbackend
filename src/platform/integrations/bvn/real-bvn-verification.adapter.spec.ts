import { randomBytes } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model } from 'mongoose';
import jwt from 'jsonwebtoken';

import { __resetPiiEncryptionKeyCache } from '../../../common/crypto/pii-encryption';
import { InMemoryMongo } from '../../../test-utils/in-memory-mongo';
import { testBvnConfigModule } from '../../../test-utils/test-bvn-config.module';
import { EncryptionService } from '../../encryption/encryption.service';
import { BvnCallLogService } from './bvn-call-log.service';
import { BvnHttpClient } from './bvn-http-client.service';
import { BvnProviderAuthService } from './bvn-provider-auth.service';
import { BvnConsentExpiredException } from './exceptions/bvn-consent-expired.exception';
import { BvnOtpInvalidException } from './exceptions/bvn-otp-invalid.exception';
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

  describe('initiateConsent', () => {
    it('parses a double-wrapped {success, payload:{...}} response', async () => {
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(mockResponse(200, LOGIN_RESPONSE))
        .mockResolvedValueOnce(
          mockResponse(200, {
            success: true,
            payload: {
              message: 'ok',
              consentToken: jwt.sign({ bvn: '12345678901' }, 'x', { expiresIn: '10m' }),
              phoneNumber: '*******4166',
              expiresInMinutes: 10,
            },
          }),
        );

      const result = await adapter.initiateConsent('12345678901');

      expect(result.consentToken).toEqual(expect.any(String));
      expect(result.otpSentToPhone).toBe('*******4166');
      expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());

      const logs = await callLogModel.find({ step: 'CONSENT_INITIATE' }).exec();
      expect(logs).toHaveLength(1);
      expect(logs[0]?.success).toBe(true);
    });

    it('throws BvnProviderUnavailableException and logs failure when the provider rejects the call', async () => {
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(mockResponse(200, LOGIN_RESPONSE))
        .mockResolvedValueOnce(mockResponse(422, { error: 'No phone number on record' }));

      await expect(adapter.initiateConsent('12345678901')).rejects.toThrow(
        BvnProviderUnavailableException,
      );

      const logs = await callLogModel.find({ step: 'CONSENT_INITIATE' }).exec();
      expect(logs).toHaveLength(1);
      expect(logs[0]?.success).toBe(false);
    });
  });

  describe('confirmConsent', () => {
    function validConsentToken(): string {
      return jwt.sign({ bvn: '12345678901' }, 'x', { expiresIn: '10m' });
    }

    it('parses a double-nested {success, payload:{payload:{...}}} response', async () => {
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(mockResponse(200, LOGIN_RESPONSE))
        .mockResolvedValueOnce(
          mockResponse(200, {
            success: true,
            payload: {
              message: 'BVN KYC consent verified successfully',
              payload: {
                bvn: '12345678901',
                firstName: 'Ada',
                lastName: 'Okoye',
                dateOfBirth: '1990-01-01',
                phoneNumber: '08012345678',
                raw: { BVN: '12345678901' },
              },
            },
          }),
        );

      const details = await adapter.confirmConsent(validConsentToken(), '123456');

      expect(details).toEqual({
        bvn: '12345678901',
        firstName: 'Ada',
        lastName: 'Okoye',
        otherNames: undefined,
        dateOfBirth: '1990-01-01',
        phoneNumber: '08012345678',
        rawResponse: { BVN: '12345678901' },
      });

      const logs = await callLogModel.find({ step: 'CONSENT_CONFIRM' }).exec();
      expect(logs).toHaveLength(1);
      expect(logs[0]?.success).toBe(true);
    });

    it('throws BvnOtpInvalidException on a 401 without retrying (401 is a business outcome here, not an auth failure)', async () => {
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(mockResponse(200, LOGIN_RESPONSE))
        .mockResolvedValueOnce(mockResponse(401, { error: 'Invalid OTP' }));

      await expect(adapter.confirmConsent(validConsentToken(), '000000')).rejects.toThrow(
        BvnOtpInvalidException,
      );

      // exactly 2 calls: login + the one verify attempt — no wasted retry
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('throws BvnConsentExpiredException when the provider reports the token invalid/expired (400)', async () => {
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(mockResponse(200, LOGIN_RESPONSE))
        .mockResolvedValueOnce(
          mockResponse(400, { error: 'Consent token is invalid or has expired' }),
        );

      await expect(adapter.confirmConsent(validConsentToken(), '123456')).rejects.toThrow(
        BvnConsentExpiredException,
      );
    });

    it('throws BvnConsentExpiredException client-side, without any HTTP call, for an already-expired token', async () => {
      fetchSpy = jest.spyOn(global, 'fetch');
      const expiredToken = jwt.sign({ bvn: '12345678901' }, 'x', { expiresIn: -10 });

      await expect(adapter.confirmConsent(expiredToken, '123456')).rejects.toThrow(
        BvnConsentExpiredException,
      );
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('directVerify', () => {
    it('parses a single-level {success, payload:{...}} response', async () => {
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(mockResponse(200, LOGIN_RESPONSE))
        .mockResolvedValueOnce(
          mockResponse(200, {
            message: 'BVN verified successfully',
            success: true,
            payload: {
              bvn: '12345678901',
              firstName: 'Chuka',
              lastName: 'Nwosu',
              dateOfBirth: '1985-05-05',
              phoneNumber: '08099998888',
              raw: { BVN: '12345678901' },
            },
          }),
        );

      const details = await adapter.directVerify('12345678901');

      expect(details.firstName).toBe('Chuka');
      expect(details.bvn).toBe('12345678901');

      const logs = await callLogModel.find({ step: 'DIRECT_VERIFY' }).exec();
      expect(logs).toHaveLength(1);
      expect(logs[0]?.success).toBe(true);
    });

    it('threads calledBy/entityType/entityId through to the BvnCallLog entry', async () => {
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(mockResponse(200, LOGIN_RESPONSE))
        .mockResolvedValueOnce(
          mockResponse(200, { data: { bvn: '12345678901', firstName: 'A', lastName: 'B' } }),
        );

      await adapter.directVerify('12345678901', {
        calledBy: 'staff-1',
        entityType: 'STAFF',
        entityId: 'staff-1',
      });

      const [log] = await callLogModel.find({ step: 'DIRECT_VERIFY' }).exec();
      expect(log?.calledBy).toBe('staff-1');
      expect(log?.calledForEntityType).toBe('STAFF');
      expect(log?.calledForEntityId).toBe('staff-1');
    });

    it('throws BvnProviderUnavailableException on a malformed/failed response', async () => {
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(mockResponse(200, LOGIN_RESPONSE))
        .mockResolvedValueOnce(mockResponse(500, { error: 'provider down' }));

      await expect(adapter.directVerify('12345678901')).rejects.toThrow(
        BvnProviderUnavailableException,
      );
    });
  });
});
