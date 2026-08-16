import { randomBytes } from 'node:crypto';

import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model } from 'mongoose';

import { __resetPiiEncryptionKeyCache } from '../../../common/crypto/pii-encryption';
import { InMemoryMongo } from '../../../test-utils/in-memory-mongo';
import { EncryptionService } from '../../encryption/encryption.service';
import { BvnCallLogService } from './bvn-call-log.service';
import { BvnConsentExpiredException } from './exceptions/bvn-consent-expired.exception';
import { BvnOtpInvalidException } from './exceptions/bvn-otp-invalid.exception';
import { MOCK_BVN_OTP, MockBvnVerificationAdapter } from './mock-bvn-verification.adapter';
import { BvnCallLog, BvnCallLogDocument, BvnCallLogSchema } from './schemas/bvn-call-log.schema';

describe('MockBvnVerificationAdapter', () => {
  const mongo = new InMemoryMongo();
  let moduleRef: TestingModule;
  let adapter: MockBvnVerificationAdapter;

  beforeAll(async () => {
    process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    __resetPiiEncryptionKeyCache();
    await mongo.start();

    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri()),
        MongooseModule.forFeature([{ name: BvnCallLog.name, schema: BvnCallLogSchema }]),
      ],
      providers: [BvnCallLogService, EncryptionService, MockBvnVerificationAdapter],
    }).compile();
  }, 60_000);

  beforeEach(() => {
    adapter = moduleRef.get(MockBvnVerificationAdapter);
  });

  afterEach(async () => {
    await mongo.clearAllCollections();
  });

  afterAll(async () => {
    await moduleRef.close();
    await mongo.stop();
  });

  it('runs the full consent -> confirm flow end to end with no live calls', async () => {
    const initiation = await adapter.initiateConsent('12345678901');
    const details = await adapter.confirmConsent(initiation.consentToken, MOCK_BVN_OTP);

    expect(details.bvn).toBe('12345678901');
    expect(details.firstName).toBeTruthy();
  });

  it('throws BvnOtpInvalidException for any OTP other than the fixed mock OTP', async () => {
    const initiation = await adapter.initiateConsent('12345678901');

    await expect(adapter.confirmConsent(initiation.consentToken, '999999')).rejects.toThrow(
      BvnOtpInvalidException,
    );
  });

  it('throws BvnConsentExpiredException for an unknown/already-used consent token', async () => {
    await expect(adapter.confirmConsent('never-issued-token', MOCK_BVN_OTP)).rejects.toThrow(
      BvnConsentExpiredException,
    );
  });

  it('a consent token is one-time-use — confirming twice fails the second time', async () => {
    const initiation = await adapter.initiateConsent('12345678901');
    await adapter.confirmConsent(initiation.consentToken, MOCK_BVN_OTP);

    await expect(adapter.confirmConsent(initiation.consentToken, MOCK_BVN_OTP)).rejects.toThrow(
      BvnConsentExpiredException,
    );
  });

  it('directVerify works standalone, with no prior consent', async () => {
    const details = await adapter.directVerify('10987654321');
    expect(details.bvn).toBe('10987654321');
  });

  it('writes BvnCallLog entries for every call', async () => {
    const callLogModel = moduleRef.get<Model<BvnCallLogDocument>>(getModelToken(BvnCallLog.name));
    await adapter.directVerify('12345678901');

    const logs = await callLogModel.find({ step: 'DIRECT_VERIFY' }).exec();
    expect(logs).toHaveLength(1);
  });
});
