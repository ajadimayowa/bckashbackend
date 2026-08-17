import { ConfigService } from '@nestjs/config';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model } from 'mongoose';

import { InMemoryMongo } from '../../../test-utils/in-memory-mongo';
import { RealSmsAdapter } from './real-sms.adapter';
import { SmsCallLog, SmsCallLogDocument, SmsCallLogSchema } from './schemas/sms-call-log.schema';
import { SmsCallLogService } from './sms-call-log.service';

function mockResponse(status: number, body: unknown): Response {
  return { status, json: () => Promise.resolve(body) } as Response;
}

function fakeConfigService(): ConfigService {
  return {
    get: () => ({
      apiKey: 'test-api-key',
      senderId: 'FloathHub',
      baseUrl: 'https://v3.api.termii.com',
      useMock: false,
    }),
  } as unknown as ConfigService;
}

describe('RealSmsAdapter', () => {
  const mongo = new InMemoryMongo();
  let moduleRef: TestingModule;
  let adapter: RealSmsAdapter;
  let callLogModel: Model<SmsCallLogDocument>;
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  beforeAll(async () => {
    await mongo.start();
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri()),
        MongooseModule.forFeature([{ name: SmsCallLog.name, schema: SmsCallLogSchema }]),
      ],
      providers: [SmsCallLogService],
    }).compile();
    callLogModel = moduleRef.get(getModelToken(SmsCallLog.name));
  }, 60_000);

  beforeEach(() => {
    adapter = new RealSmsAdapter(fakeConfigService(), moduleRef.get(SmsCallLogService));
  });

  afterEach(async () => {
    await mongo.clearAllCollections();
    fetchSpy?.mockRestore();
  });

  afterAll(async () => {
    await moduleRef.close();
    await mongo.stop();
  });

  it('returns { success: true, messageId } and logs a successful call', async () => {
    fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(mockResponse(200, { message_id: 'sms-1', message: 'Sent' }));

    const result = await adapter.send('08012345678', 'Your loan was disbursed');

    expect(result).toEqual({ success: true, messageId: 'sms-1' });
    const [call] = fetchSpy.mock.calls;
    expect(call![0]).toBe('https://v3.api.termii.com/api/sms/send');
    const body = JSON.parse(call![1]!.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      api_key: 'test-api-key',
      to: '2348012345678', // normalized
      from: 'FloathHub',
      sms: 'Your loan was disbursed',
      type: 'plain',
      channel: 'generic',
    });

    const logs = await callLogModel.find({}).exec();
    expect(logs).toHaveLength(1);
    expect(logs[0]!.success).toBe(true);
    expect(logs[0]!.toPhoneNumber).toBe('2348012345678');
    expect(logs[0]!.providerMessageId).toBe('sms-1');
  });

  it('returns { success: false, error } — never throws — and logs the failure, on a bad provider response', async () => {
    fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(mockResponse(400, { message: 'Invalid sender ID' }));

    const result = await adapter.send('08012345678', 'Hello');

    expect(result).toEqual({ success: false, error: 'Invalid sender ID' });
    const logs = await callLogModel.find({}).exec();
    expect(logs).toHaveLength(1);
    expect(logs[0]!.success).toBe(false);
    expect(logs[0]!.errorMessage).toBe('Invalid sender ID');
  });

  it('returns { success: false, error } — never throws — and logs the failure, on a network error', async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await adapter.send('08012345678', 'Hello');

    expect(result).toEqual({ success: false, error: 'ECONNREFUSED' });
    const logs = await callLogModel.find({}).exec();
    expect(logs).toHaveLength(1);
    expect(logs[0]!.success).toBe(false);
    expect(logs[0]!.errorMessage).toBe('ECONNREFUSED');
  });
});
