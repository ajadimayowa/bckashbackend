import { randomBytes } from 'node:crypto';

import { getQueueToken } from '@nestjs/bullmq';
import { getModelToken } from '@nestjs/mongoose';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { Model, Types } from 'mongoose';

import { __resetPiiEncryptionKeyCache } from '../src/common/crypto/pii-encryption';
import { NotificationTrigger } from '../src/common/enums/notification.enums';
import { AppModule } from '../src/app.module';
import { InMemoryMongo } from '../src/test-utils/in-memory-mongo';
import {
  EMAIL_ADAPTER,
  EmailAdapter,
} from '../src/platform/integrations/brevo/interfaces/email-adapter.interface';
import {
  SMS_ADAPTER,
  SmsAdapter,
} from '../src/platform/integrations/termii/interfaces/sms-adapter.interface';
import {
  NOTIFICATION_PORT,
  NotificationPort,
} from '../src/modules/loans/interfaces/notification-port.interface';
import { RealNotificationPort } from '../src/modules/notifications/real-notification.port';
import { NotificationService } from '../src/modules/notifications/notification.service';
import { NOTIFICATION_DISPATCH_QUEUE } from '../src/modules/notifications/notification-dispatch.queue';
import {
  NotificationDeadLetterLog,
  NotificationDeadLetterLogDocument,
} from '../src/modules/notifications/schemas/notification-dead-letter-log.schema';
import {
  PendingNotificationLog,
  PendingNotificationLogDocument,
} from '../src/modules/notifications/schemas/pending-notification-log.schema';
import { Customer, CustomerDocument } from '../src/modules/customers/schemas/customer.schema';

/**
 * *** REQUIRES LIVE REDIS — SEE PHASE_11_NOTES.md ***
 * The first e2e suite in this project to depend on a real Redis instance
 * (in addition to the usual mongodb-memory-server), because the brief
 * explicitly requires verifying BullMQ's own mechanics (stable-job-id
 * dedupe, real retry/backoff, dead-lettering on exhaustion) — these can't be
 * honestly verified without a real queue backend. Uses `.env`'s
 * REDIS_HOST/PORT (localhost:6379 in this dev environment, confirmed
 * available). `MONGO_URI` is overridden to an in-memory replica set before
 * boot so this never touches the real Atlas dev DB; `BREVO_USE_MOCK`/
 * `TERMII_USE_MOCK` are forced to `true` so this never sends a real email/
 * SMS. `NOTIFICATION_MAX_ATTEMPTS`/`NOTIFICATION_BACKOFF_BASE_DELAY_MS` are
 * overridden low so the retry/backoff test completes in a reasonable time.
 *
 * Boots the REAL `AppModule` — not a hand-assembled subset — specifically
 * so the `NOTIFICATION_PORT` rebinding test proves the *actual* production
 * DI wiring, not an approximation of it.
 */
describe('Notification dispatch (e2e, live Redis)', () => {
  jest.setTimeout(60_000);

  const mongo = new InMemoryMongo();
  let app: INestApplication;
  let moduleRef: TestingModule;
  let queue: Queue;
  let emailAdapter: EmailAdapter;
  let smsAdapter: SmsAdapter;
  let notificationService: NotificationService;
  let customerModel: Model<CustomerDocument>;
  let deadLetterModel: Model<NotificationDeadLetterLogDocument>;
  let pendingLogModel: Model<PendingNotificationLogDocument>;

  beforeAll(async () => {
    process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    __resetPiiEncryptionKeyCache();

    await mongo.start();
    process.env.MONGO_URI = mongo.getUri();
    process.env.BREVO_USE_MOCK = 'true';
    process.env.TERMII_USE_MOCK = 'true';
    process.env.NOTIFICATION_MAX_ATTEMPTS = '3';
    process.env.NOTIFICATION_BACKOFF_BASE_DELAY_MS = '50';

    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    queue = moduleRef.get<Queue>(getQueueToken(NOTIFICATION_DISPATCH_QUEUE));
    emailAdapter = moduleRef.get(EMAIL_ADAPTER);
    smsAdapter = moduleRef.get(SMS_ADAPTER);
    notificationService = moduleRef.get(NotificationService);
    customerModel = moduleRef.get(getModelToken(Customer.name));
    deadLetterModel = moduleRef.get(getModelToken(NotificationDeadLetterLog.name));
    pendingLogModel = moduleRef.get(getModelToken(PendingNotificationLog.name));
  }, 60_000);

  afterEach(async () => {
    await queue.obliterate({ force: true });
    await mongo.clearAllCollections();
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
    await mongo.stop();
  });

  async function createCustomer(): Promise<CustomerDocument> {
    return customerModel.create({
      firstName: 'A',
      lastName: 'B',
      phoneNumber: '08012345678',
      email: 'customer@example.com',
      branchId: new Types.ObjectId(),
      createdBy: new Types.ObjectId(),
    });
  }

  async function waitUntil(
    predicate: () => Promise<boolean> | boolean,
    timeoutMs = 10_000,
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await predicate()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
  }

  describe('NOTIFICATION_PORT rebinding — proves the real DI wiring, not just that the class compiles', () => {
    it('resolves NOTIFICATION_PORT to RealNotificationPort in the actual LoansModule/AppModule graph', () => {
      const port = moduleRef.get<NotificationPort>(NOTIFICATION_PORT);
      expect(port).toBeInstanceOf(RealNotificationPort);
    });

    it('calling the resolved port enqueues a real BullMQ job — never a PendingNotificationLog write', async () => {
      const customer = await createCustomer();
      const port = moduleRef.get<NotificationPort>(NOTIFICATION_PORT);
      const sendSpy = jest
        .spyOn(smsAdapter, 'send')
        .mockResolvedValue({ success: true, messageId: 'x' });

      await port.sendLoanRaisedNotification(customer._id.toString(), 50_000, new Date());

      await waitUntil(() => sendSpy.mock.calls.length > 0);
      const pendingCount = await pendingLogModel.countDocuments({}).exec();
      expect(pendingCount).toBe(0); // the old Phase 8 stub path was never taken
    });
  });

  describe('stable job id dedupe', () => {
    it('dispatching the same (type, sourceEntityId, recipientId) twice results in only one job actually processed', async () => {
      const sendSpy = jest
        .spyOn(smsAdapter, 'send')
        .mockResolvedValue({ success: true, messageId: 'x' });
      const recipient = {
        kind: 'CUSTOMER' as const,
        id: 'cust-dedupe',
        email: null,
        phone: '2348012345678',
      };

      await notificationService.dispatch(
        NotificationTrigger.LOAN_RAISED,
        'source-1',
        recipient,
        {},
      );
      await notificationService.dispatch(
        NotificationTrigger.LOAN_RAISED,
        'source-1',
        recipient,
        {},
      );

      await waitUntil(() => sendSpy.mock.calls.length > 0);
      // Give a genuinely-duplicated job a moment to also fire, if it exists.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(sendSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('retry/backoff and dead-lettering', () => {
    it('exhausts every configured retry attempt then writes a NotificationDeadLetterLog with the right attemptCount/lastError', async () => {
      jest
        .spyOn(emailAdapter, 'send')
        .mockResolvedValue({ success: false, error: 'SMTP permanently down' });
      jest
        .spyOn(smsAdapter, 'send')
        .mockResolvedValue({ success: false, error: 'Termii permanently down' });
      const recipient = {
        kind: 'CUSTOMER' as const,
        id: 'cust-deadletter',
        email: 'customer@example.com',
        phone: '2348012345678',
      };

      await notificationService.dispatch(
        NotificationTrigger.PENALTY_CHARGED,
        'source-2',
        recipient,
        {
          amountKobo: 1_000,
          context: 'test',
        },
      );

      await waitUntil(async () => (await deadLetterModel.countDocuments({}).exec()) > 0, 15_000);

      const entry = await deadLetterModel.findOne({}).exec();
      expect(entry).not.toBeNull();
      expect(entry!.recipientId).toBe('cust-deadletter');
      expect(entry!.attemptCount).toBe(3); // NOTIFICATION_MAX_ATTEMPTS overridden to 3 above
      expect(entry!.lastError).toContain('SMTP permanently down');
    });
  });
});
