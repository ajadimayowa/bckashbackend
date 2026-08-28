import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Job } from 'bullmq';
import { Model } from 'mongoose';

import { NotificationCategory, NotificationChannel, NotificationTrigger } from '../../common/enums/notification.enums';
import { InMemoryMongo } from '../../test-utils/in-memory-mongo';
import { NotificationInboxService } from './notification-inbox.service';
import { NotificationDispatchProcessor } from './notification-dispatch.processor';
import { NotificationDispatchJobData } from './notification-dispatch.queue';
import {
  NotificationDeadLetterLog,
  NotificationDeadLetterLogDocument,
  NotificationDeadLetterLogSchema,
} from './schemas/notification-dead-letter-log.schema';
import { NotificationTemplateRegistry } from './templates/notification-template-registry.service';

function fakeJob(
  data: Partial<NotificationDispatchJobData> & Pick<NotificationDispatchJobData, 'type' | 'recipient' | 'payload'>,
  overrides: Partial<{ attemptsMade: number; attempts: number }> = {},
): Job<NotificationDispatchJobData> {
  const fullData: NotificationDispatchJobData = {
    sourceEntityId: 'src-1',
    category: NotificationCategory.GENERAL,
    branchId: null,
    ...data,
  };
  return {
    data: fullData,
    attemptsMade: overrides.attemptsMade ?? 1,
    opts: { attempts: overrides.attempts ?? 5 },
  } as unknown as Job<NotificationDispatchJobData>;
}

describe('NotificationDispatchProcessor', () => {
  const mongo = new InMemoryMongo();
  let moduleRef: TestingModule;
  let deadLetterModel: Model<NotificationDeadLetterLogDocument>;
  // Plain `{ send: jest.Mock }` rather than `jest.Mocked<EmailAdapter>` —
  // referencing `.send` bare in assertions below (not invoking it) would
  // otherwise trip @typescript-eslint/unbound-method against the interface's
  // method signature.
  let emailAdapter: { send: jest.Mock };
  let smsAdapter: { send: jest.Mock };
  let notificationInboxService: { persistCopies: jest.Mock };
  let processor: NotificationDispatchProcessor;

  beforeAll(async () => {
    await mongo.start();
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri()),
        MongooseModule.forFeature([
          { name: NotificationDeadLetterLog.name, schema: NotificationDeadLetterLogSchema },
        ]),
      ],
      providers: [NotificationTemplateRegistry],
    }).compile();
    deadLetterModel = moduleRef.get(getModelToken(NotificationDeadLetterLog.name));
  }, 60_000);

  beforeEach(() => {
    emailAdapter = { send: jest.fn() };
    smsAdapter = { send: jest.fn() };
    // A bare mock, not a real NotificationInboxService — the in-app persist
    // step is exercised by NotificationInboxService's own spec; this
    // processor's tests only need to know it never affects email/SMS
    // outcomes either way (see the dedicated test below).
    notificationInboxService = { persistCopies: jest.fn().mockResolvedValue(undefined) };
    processor = new NotificationDispatchProcessor(
      emailAdapter,
      smsAdapter,
      moduleRef.get(NotificationTemplateRegistry),
      notificationInboxService as unknown as NotificationInboxService,
      deadLetterModel,
    );
  });

  afterEach(async () => {
    await mongo.clearAllCollections();
  });

  afterAll(async () => {
    await moduleRef.close();
    await mongo.stop();
  });

  it('a customer with no email on file still receives the SMS leg without the whole dispatch failing', async () => {
    emailAdapter.send.mockResolvedValue({ success: true }); // should never be called
    smsAdapter.send.mockResolvedValue({ success: true, messageId: 'sms-1' });

    const job = fakeJob({
      type: NotificationTrigger.DISBURSEMENT_COMPLETED,
      recipient: { kind: 'CUSTOMER', id: 'cust-1', email: null, phone: '2348012345678' },
      payload: { amountKobo: 10_000, channel: 'TRANSFER' },
    });

    await expect(processor.process(job)).resolves.toBeUndefined();
    expect(emailAdapter.send).not.toHaveBeenCalled();
    expect(smsAdapter.send).toHaveBeenCalledWith('2348012345678', expect.any(String));
  });

  it('persists an in-app copy alongside the email/SMS legs, keyed off sourceEntityId/category/branchId', async () => {
    emailAdapter.send.mockResolvedValue({ success: true });
    smsAdapter.send.mockResolvedValue({ success: true, messageId: 'sms-1' });

    const job = fakeJob({
      type: NotificationTrigger.BRANCH_FUNDING_RECORDED,
      recipient: { kind: 'STAFF', id: 'staff-1', email: 'm@example.com', phone: '2348012345678' },
      payload: { branchName: 'Ikeja Branch', amountKobo: 500_000 },
      sourceEntityId: 'funding-1',
      category: NotificationCategory.BRANCH_MANAGER,
      branchId: 'branch-1',
    });

    await processor.process(job);

    expect(notificationInboxService.persistCopies).toHaveBeenCalledWith(
      expect.objectContaining({
        type: NotificationTrigger.BRANCH_FUNDING_RECORDED,
        sourceEntityId: 'funding-1',
        category: NotificationCategory.BRANCH_MANAGER,
        branchId: 'branch-1',
        primaryRecipientStaffId: 'staff-1',
      }),
    );
  });

  it('a failure persisting the in-app copy never blocks the email/SMS legs', async () => {
    emailAdapter.send.mockResolvedValue({ success: true });
    smsAdapter.send.mockResolvedValue({ success: true, messageId: 'sms-1' });
    notificationInboxService.persistCopies.mockRejectedValue(new Error('db down'));

    const job = fakeJob({
      type: NotificationTrigger.LOAN_RAISED,
      recipient: { kind: 'CUSTOMER', id: 'cust-6', email: 'c@example.com', phone: '2348012345678' },
      payload: {},
    });

    await expect(processor.process(job)).resolves.toBeUndefined();
    expect(emailAdapter.send).toHaveBeenCalled();
    expect(smsAdapter.send).toHaveBeenCalled();
  });

  it('logs a warning and resolves (no retry) when neither email nor phone is available', async () => {
    const job = fakeJob({
      type: NotificationTrigger.LOAN_RAISED,
      recipient: { kind: 'CUSTOMER', id: 'cust-2', email: null, phone: '' as unknown as string },
      payload: {},
    });
    // Simulate "no phone" by clearing it after construction (phone is
    // typed non-null for CUSTOMER, but the processor only checks truthiness).
    (job.data.recipient as { phone: string | null }).phone = null;

    await expect(processor.process(job)).resolves.toBeUndefined();
    expect(emailAdapter.send).not.toHaveBeenCalled();
    expect(smsAdapter.send).not.toHaveBeenCalled();
  });

  it('throws (triggering a retry) when an attempted channel fails', async () => {
    emailAdapter.send.mockResolvedValue({ success: false, error: 'SMTP down' });
    smsAdapter.send.mockResolvedValue({ success: true, messageId: 'sms-1' });

    const job = fakeJob({
      type: NotificationTrigger.LOAN_RAISED,
      recipient: { kind: 'CUSTOMER', id: 'cust-3', email: 'c@example.com', phone: '2348012345678' },
      payload: {},
    });

    await expect(processor.process(job)).rejects.toThrow(/SMTP down/);
  });

  describe('dead-lettering on final failure', () => {
    it('writes a NotificationDeadLetterLog entry only once attempts are exhausted (attemptsMade >= attempts)', async () => {
      const job = fakeJob(
        {
          type: NotificationTrigger.PENALTY_CHARGED,
          recipient: { kind: 'STAFF', id: 'cust-4', email: 'c@example.com', phone: null },
          payload: { amountKobo: 500, context: 'test' },
        },
        { attemptsMade: 5, attempts: 5 },
      );

      await processor.onFailed(job, new Error('email: SMTP down'));

      const entries = await deadLetterModel.find({}).exec();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.recipientId).toBe('cust-4');
      expect(entries[0]!.channel).toBe(NotificationChannel.EMAIL);
      expect(entries[0]!.lastError).toBe('email: SMTP down');
      expect(entries[0]!.attemptCount).toBe(5);
    });

    it('does NOT dead-letter on an intermediate retry failure (attemptsMade < attempts)', async () => {
      const job = fakeJob(
        {
          type: NotificationTrigger.PENALTY_CHARGED,
          recipient: { kind: 'STAFF', id: 'cust-5', email: 'c@example.com', phone: null },
          payload: {},
        },
        { attemptsMade: 2, attempts: 5 },
      );

      await processor.onFailed(job, new Error('email: SMTP down'));

      const entries = await deadLetterModel.find({}).exec();
      expect(entries).toHaveLength(0);
    });
  });
});
