import { randomBytes } from 'node:crypto';

import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model } from 'mongoose';

import { __resetPiiEncryptionKeyCache } from '../../../common/crypto/pii-encryption';
import { InMemoryMongo } from '../../../test-utils/in-memory-mongo';
import { EncryptionService } from '../../encryption/encryption.service';
import { BvnCallLogService } from './bvn-call-log.service';
import { MockBvnVerificationAdapter } from './mock-bvn-verification.adapter';
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

  it('directVerify is deterministic — same bvn always resolves the same details', async () => {
    const first = await adapter.directVerify('12345678901');
    const second = await adapter.directVerify('12345678901');

    expect(first.bvn).toBe('12345678901');
    expect(first.firstName).toBeTruthy();
    expect(first).toEqual(second);
  });

  it('writes a BvnCallLog entry for every call', async () => {
    const callLogModel = moduleRef.get<Model<BvnCallLogDocument>>(getModelToken(BvnCallLog.name));
    await adapter.directVerify('12345678901');

    const logs = await callLogModel.find({ step: 'DIRECT_VERIFY' }).exec();
    expect(logs).toHaveLength(1);
    expect(logs[0]?.success).toBe(true);
  });
});
