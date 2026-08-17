import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model, Types } from 'mongoose';

import { InMemoryMongo } from '../../../test-utils/in-memory-mongo';
import {
  Customer,
  CustomerDocument,
  CustomerSchema,
} from '../../customers/schemas/customer.schema';
import { CustomerRecipientResolver } from './customer-recipient.resolver';

describe('CustomerRecipientResolver', () => {
  const mongo = new InMemoryMongo();
  let moduleRef: TestingModule;
  let resolver: CustomerRecipientResolver;
  let customerModel: Model<CustomerDocument>;

  beforeAll(async () => {
    await mongo.start();
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri()),
        MongooseModule.forFeature([{ name: Customer.name, schema: CustomerSchema }]),
      ],
      providers: [
        {
          provide: CustomerRecipientResolver,
          useFactory: (model: Model<CustomerDocument>) => {
            const fakeCustomerService = { findById: (id: string) => model.findById(id).exec() };
            return new CustomerRecipientResolver(fakeCustomerService as never);
          },
          inject: [getModelToken(Customer.name)],
        },
      ],
    }).compile();
    resolver = moduleRef.get(CustomerRecipientResolver);
    customerModel = moduleRef.get(getModelToken(Customer.name));
  }, 60_000);

  afterEach(async () => {
    await mongo.clearAllCollections();
  });

  afterAll(async () => {
    await moduleRef.close();
    await mongo.stop();
  });

  it('resolves email and phone straight off the Customer record', async () => {
    const customer = await customerModel.create({
      firstName: 'A',
      lastName: 'B',
      phoneNumber: '08012345678',
      email: 'a@example.com',
      branchId: new Types.ObjectId(),
      createdBy: new Types.ObjectId(),
    });

    const recipient = await resolver.resolve(customer._id.toString());

    expect(recipient).toEqual({
      kind: 'CUSTOMER',
      id: customer._id.toString(),
      email: 'a@example.com',
      phone: '08012345678',
    });
  });

  it('returns email: null (not a thrown error) for a customer with no email on file', async () => {
    const customer = await customerModel.create({
      firstName: 'A',
      lastName: 'B',
      phoneNumber: '08012345678',
      email: null,
      branchId: new Types.ObjectId(),
      createdBy: new Types.ObjectId(),
    });

    const recipient = await resolver.resolve(customer._id.toString());

    expect(recipient.email).toBeNull();
    expect(recipient.phone).toBe('08012345678');
  });
});
