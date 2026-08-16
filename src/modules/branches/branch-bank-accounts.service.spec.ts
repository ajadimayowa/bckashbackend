import { ConflictException } from '@nestjs/common';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model, Types } from 'mongoose';

import { BranchBankAccountPurpose } from '../../common/enums/branch.enums';
import { InMemoryMongo } from '../../test-utils/in-memory-mongo';
import { BranchBankAccountsService } from './branch-bank-accounts.service';
import {
  BranchBankAccount,
  BranchBankAccountDocument,
  BranchBankAccountSchema,
} from './schemas/branch-bank-account.schema';

describe('BranchBankAccountsService', () => {
  const mongo = new InMemoryMongo();
  let moduleRef: TestingModule;
  let service: BranchBankAccountsService;
  let bankAccountModel: Model<BranchBankAccountDocument>;

  beforeAll(async () => {
    await mongo.start();

    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri()),
        MongooseModule.forFeature([
          { name: BranchBankAccount.name, schema: BranchBankAccountSchema },
        ]),
      ],
      providers: [BranchBankAccountsService],
    }).compile();

    service = moduleRef.get(BranchBankAccountsService);
    bankAccountModel = moduleRef.get(getModelToken(BranchBankAccount.name));
  }, 60_000);

  afterEach(async () => {
    await mongo.clearAllCollections();
  });

  afterAll(async () => {
    await moduleRef.close();
    await mongo.stop();
  });

  function baseDto(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      branchId: new Types.ObjectId().toString(),
      bankName: 'First Coop Bank',
      accountNumber: '0123456789',
      accountName: 'Branch Collection Account',
      purpose: BranchBankAccountPurpose.REPAYMENT_COLLECTION,
      ...overrides,
    };
  }

  describe('create', () => {
    it('creates an account, active by default', async () => {
      const account = await service.create(baseDto());
      expect(account.active).toBe(true);
    });

    it('allows a branch to have multiple accounts, including multiple of the same purpose', async () => {
      const branchId = new Types.ObjectId().toString();
      await service.create(baseDto({ branchId, accountNumber: '1111111111' }));
      await service.create(baseDto({ branchId, accountNumber: '2222222222' }));

      const accounts = await service.findAll(branchId);
      expect(accounts).toHaveLength(2);
      expect(
        accounts.every((a) => a.purpose === BranchBankAccountPurpose.REPAYMENT_COLLECTION),
      ).toBe(true);
    });

    it('enforces uniqueness on (bankName, accountNumber) at the DB level, even across different branches', async () => {
      await service.create(baseDto());

      await expect(
        service.create(baseDto({ branchId: new Types.ObjectId().toString() })), // different branch, same bank+account number
      ).rejects.toThrow(ConflictException);
    });

    it('allows the same bank with a different account number', async () => {
      await service.create(baseDto({ accountNumber: '0123456789' }));

      await expect(service.create(baseDto({ accountNumber: '9999999999' }))).resolves.toBeDefined();
    });
  });

  describe('update (deactivation, not deletion)', () => {
    it('retires an account via active: false rather than deleting it', async () => {
      const account = await service.create(baseDto());

      const updated = await service.update(account._id.toString(), { active: false });

      expect(updated.active).toBe(false);
      // still resolvable by id — a "deleted" account would 404 here instead
      await expect(service.findById(account._id.toString())).resolves.toBeDefined();
      const stillInDb = await bankAccountModel.findById(account._id).exec();
      expect(stillInDb).not.toBeNull();
    });

    it('still enforces the uniqueness constraint on update', async () => {
      const first = await service.create(baseDto({ accountNumber: '1111111111' }));
      await service.create(baseDto({ accountNumber: '2222222222' }));

      await expect(
        service.update(first._id.toString(), { accountNumber: '2222222222' }),
      ).rejects.toThrow(ConflictException);
    });
  });
});
