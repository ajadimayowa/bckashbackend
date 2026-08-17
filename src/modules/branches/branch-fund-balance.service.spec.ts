import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model, Types } from 'mongoose';

import { InMemoryMongo } from '../../test-utils/in-memory-mongo';
import { BranchFundBalanceService } from './branch-fund-balance.service';
import { BRANCH_CREATED_EVENT } from './events/branch.events';
import { InsufficientBranchFundsException } from './exceptions/insufficient-branch-funds.exception';
import {
  BranchFundBalance,
  BranchFundBalanceDocument,
  BranchFundBalanceSchema,
} from './schemas/branch-fund-balance.schema';

describe('BranchFundBalanceService', () => {
  const mongo = new InMemoryMongo();
  let moduleRef: TestingModule;
  let service: BranchFundBalanceService;
  let balanceModel: Model<BranchFundBalanceDocument>;

  beforeAll(async () => {
    await mongo.start();

    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri()),
        MongooseModule.forFeature([
          { name: BranchFundBalance.name, schema: BranchFundBalanceSchema },
        ]),
        EventEmitterModule.forRoot(),
      ],
      providers: [BranchFundBalanceService],
    }).compile();

    service = moduleRef.get(BranchFundBalanceService);
    balanceModel = moduleRef.get(getModelToken(BranchFundBalance.name));

    await moduleRef.init(); // registers the @OnEvent listener
  }, 60_000);

  afterEach(async () => {
    await mongo.clearAllCollections();
  });

  afterAll(async () => {
    await moduleRef.close();
    await mongo.stop();
  });

  describe('getBalance', () => {
    it('returns 0, not an error, for a branch with no funding history', async () => {
      const balance = await service.getBalance(new Types.ObjectId().toString());
      expect(balance).toBe(0);
    });
  });

  describe('handleBranchCreated (branch.created listener)', () => {
    it('initializes a zero balance document when a branch is created', async () => {
      const branchId = new Types.ObjectId().toString();
      const eventEmitter = moduleRef.get(EventEmitter2);

      await eventEmitter.emitAsync(BRANCH_CREATED_EVENT, { branchId });

      // Explicit cast — see BranchFundBalanceService's own doc comment
      // (Phase 8 fix) on why a plain string filter against this ObjectId
      // path isn't reliable in this codebase's Mongoose setup.
      const doc = await balanceModel.findOne({ branchId: new Types.ObjectId(branchId) }).exec();
      expect(doc).not.toBeNull();
      expect(doc?.availableAmount).toBe(0);
    });

    it('is idempotent — re-firing the event does not reset an existing balance', async () => {
      const branchId = new Types.ObjectId().toString();
      const eventEmitter = moduleRef.get(EventEmitter2);
      await eventEmitter.emitAsync(BRANCH_CREATED_EVENT, { branchId });
      await service.credit(branchId, 50_000);

      await eventEmitter.emitAsync(BRANCH_CREATED_EVENT, { branchId });

      expect(await service.getBalance(branchId)).toBe(50_000);
    });
  });

  describe('credit', () => {
    it('increments the balance, creating the document if it does not exist yet', async () => {
      const branchId = new Types.ObjectId().toString();

      await service.credit(branchId, 100_000);
      await service.credit(branchId, 50_000);

      expect(await service.getBalance(branchId)).toBe(150_000);
    });
  });

  describe('debit', () => {
    it('atomically decrements when the balance is sufficient', async () => {
      const branchId = new Types.ObjectId().toString();
      await service.credit(branchId, 100_000);

      const result = await service.debit(branchId, 40_000);

      expect(result.availableAmount).toBe(60_000);
      expect(await service.getBalance(branchId)).toBe(60_000);
    });

    it('fails cleanly with no partial state change when balance is insufficient', async () => {
      const branchId = new Types.ObjectId().toString();
      await service.credit(branchId, 10_000);

      await expect(service.debit(branchId, 50_000)).rejects.toThrow(
        InsufficientBranchFundsException,
      );

      // balance must be exactly what it was before the failed attempt
      expect(await service.getBalance(branchId)).toBe(10_000);
    });

    it('fails for a branch with no balance document at all (never negative)', async () => {
      const branchId = new Types.ObjectId().toString();

      await expect(service.debit(branchId, 1)).rejects.toThrow(InsufficientBranchFundsException);
    });

    describe('concurrency', () => {
      it('lets exactly one of two simultaneous debits succeed when only one can be satisfied', async () => {
        const branchId = new Types.ObjectId().toString();
        await service.credit(branchId, 100_000); // enough for exactly one 80,000 debit, not both

        const [resultA, resultB] = await Promise.allSettled([
          service.debit(branchId, 80_000),
          service.debit(branchId, 80_000),
        ]);

        const outcomes = [resultA, resultB];
        const fulfilled = outcomes.filter((r) => r.status === 'fulfilled');
        const rejected = outcomes.filter((r) => r.status === 'rejected');

        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
          InsufficientBranchFundsException,
        );

        // exactly one debit applied — not zero, not two
        expect(await service.getBalance(branchId)).toBe(20_000);
      });

      it('lets both succeed when the balance can satisfy both, and leaves the correct remainder', async () => {
        const branchId = new Types.ObjectId().toString();
        await service.credit(branchId, 200_000);

        const results = await Promise.all([
          service.debit(branchId, 80_000),
          service.debit(branchId, 80_000),
        ]);

        expect(results).toHaveLength(2);
        expect(await service.getBalance(branchId)).toBe(40_000);
      });
    });
  });
});
