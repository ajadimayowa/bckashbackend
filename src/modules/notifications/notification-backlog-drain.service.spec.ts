import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model, Types } from 'mongoose';

import { NotificationTrigger } from '../../common/enums/notification.enums';
import { InMemoryMongo } from '../../test-utils/in-memory-mongo';
import { NotificationBacklogDrainService } from './notification-backlog-drain.service';
import { NotificationService } from './notification.service';
import { CustomerRecipientResolver } from './recipient-resolution/customer-recipient.resolver';
import {
  PendingNotificationLog,
  PendingNotificationLogDocument,
  PendingNotificationLogSchema,
} from './schemas/pending-notification-log.schema';

describe('NotificationBacklogDrainService', () => {
  const mongo = new InMemoryMongo();
  let moduleRef: TestingModule;
  let pendingModel: Model<PendingNotificationLogDocument>;
  let dispatchSpy: jest.Mock;
  let service: NotificationBacklogDrainService;

  beforeAll(async () => {
    await mongo.start();
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri()),
        MongooseModule.forFeature([
          { name: PendingNotificationLog.name, schema: PendingNotificationLogSchema },
        ]),
      ],
    }).compile();
    pendingModel = moduleRef.get(getModelToken(PendingNotificationLog.name));
  }, 60_000);

  beforeEach(() => {
    dispatchSpy = jest.fn().mockResolvedValue(undefined);
    const fakeCustomerResolver = {
      resolve: jest.fn().mockImplementation((customerId: string) => ({
        kind: 'CUSTOMER',
        id: customerId,
        email: 'customer@example.com',
        phone: '2348012345678',
      })),
    } as unknown as CustomerRecipientResolver;
    const fakeNotificationService = { dispatch: dispatchSpy } as unknown as NotificationService;
    service = new NotificationBacklogDrainService(
      pendingModel,
      fakeCustomerResolver,
      fakeNotificationService,
    );
  });

  afterEach(async () => {
    await mongo.clearAllCollections();
  });

  afterAll(async () => {
    await moduleRef.close();
    await mongo.stop();
  });

  async function seedEntry(overrides: Partial<{ dispatched: boolean }> = {}) {
    return pendingModel.create({
      type: NotificationTrigger.LOAN_RAISED,
      recipientCustomerId: new Types.ObjectId(),
      payload: { memberAmountKobo: 10_000 },
      createdAt: new Date(),
      dispatched: overrides.dispatched ?? false,
    });
  }

  it('enqueues every dispatched:false entry exactly once and marks it dispatched:true', async () => {
    const entries = await Promise.all([seedEntry(), seedEntry(), seedEntry()]);

    const result = await service.drain();

    expect(result).toEqual({ found: 3, drained: 3, skipped: 0 });
    expect(dispatchSpy).toHaveBeenCalledTimes(3);
    for (const entry of entries) {
      const reloaded = await pendingModel.findById(entry._id).exec();
      expect(reloaded!.dispatched).toBe(true);
    }
  });

  it('calls dispatch with the log entry own _id as sourceEntityId (so BullMQ dedupe covers a concurrent double-drain)', async () => {
    const entry = await seedEntry();

    await service.drain();

    expect(dispatchSpy).toHaveBeenCalledWith(
      NotificationTrigger.LOAN_RAISED,
      entry._id.toString(),
      expect.objectContaining({ kind: 'CUSTOMER' }),
      { memberAmountKobo: 10_000 },
    );
  });

  it('re-running the drain against already-dispatched entries is a safe no-op — no duplicate dispatch calls', async () => {
    await seedEntry();
    await service.drain();
    dispatchSpy.mockClear();

    const second = await service.drain();

    expect(second).toEqual({ found: 0, drained: 0, skipped: 0 });
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('leaves an entry dispatched:false (for retry on the next run) if dispatch throws, rather than marking it done', async () => {
    await seedEntry();
    dispatchSpy.mockRejectedValueOnce(new Error('queue unavailable'));

    const result = await service.drain();

    expect(result).toEqual({ found: 1, drained: 0, skipped: 1 });
    const reloaded = await pendingModel.findOne({}).exec();
    expect(reloaded!.dispatched).toBe(false);
  });

  it('ignores already-dispatched entries mixed in with pending ones', async () => {
    await seedEntry({ dispatched: true });
    await seedEntry();

    const result = await service.drain();

    expect(result).toEqual({ found: 1, drained: 1, skipped: 0 });
  });
});
