import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model, Types } from 'mongoose';

import { LoanStatus } from '../../common/enums/loan.enums';
import { WorkflowEntityType } from '../../common/enums/workflow.enums';
import { NotificationTrigger } from '../../common/enums/notification.enums';
import { InMemoryMongo } from '../../test-utils/in-memory-mongo';
import { Loan, LoanDocument, LoanSchema } from '../loans/schemas/loan.schema';
import { WorkflowEngineService } from '../../platform/workflow-engine/workflow-engine.service';
import { NotificationService } from './notification.service';
import { CustomerRecipientResolver } from './recipient-resolution/customer-recipient.resolver';
import { InvolvedPartiesResolver } from './recipient-resolution/involved-parties.resolver';
import { RealNotificationPort } from './real-notification.port';

describe('RealNotificationPort', () => {
  const mongo = new InMemoryMongo();
  let moduleRef: TestingModule;
  let loanModel: Model<LoanDocument>;
  let dispatchSpy: jest.Mock;
  let resolveInvolvedPartiesSpy: jest.Mock;
  let resolveStaffRecipientSpy: jest.Mock;
  let getHistorySpy: jest.Mock;
  let port: RealNotificationPort;

  beforeAll(async () => {
    await mongo.start();
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri()),
        MongooseModule.forFeature([{ name: Loan.name, schema: LoanSchema }]),
      ],
    }).compile();
    loanModel = moduleRef.get(getModelToken(Loan.name));
  }, 60_000);

  beforeEach(() => {
    dispatchSpy = jest.fn().mockResolvedValue(undefined);
    resolveInvolvedPartiesSpy = jest.fn();
    resolveStaffRecipientSpy = jest.fn().mockImplementation((staffId: string) => ({
      kind: 'STAFF',
      id: staffId,
      email: `${staffId}@example.com`,
      phone: '2348012345678',
    }));
    getHistorySpy = jest.fn().mockResolvedValue([]);

    const fakeCustomerResolver = {
      resolve: jest.fn().mockImplementation((customerId: string) => ({
        kind: 'CUSTOMER',
        id: customerId,
        email: 'customer@example.com',
        phone: '2348012345678',
      })),
    } as unknown as CustomerRecipientResolver;
    const fakeInvolvedPartiesResolver = {
      resolveInvolvedParties: resolveInvolvedPartiesSpy,
      resolveStaffRecipient: resolveStaffRecipientSpy,
    } as unknown as InvolvedPartiesResolver;
    const fakeWorkflowEngineService = {
      getHistory: getHistorySpy,
    } as unknown as WorkflowEngineService;
    const fakeNotificationService = { dispatch: dispatchSpy } as unknown as NotificationService;

    port = new RealNotificationPort(
      loanModel,
      fakeCustomerResolver,
      fakeInvolvedPartiesResolver,
      fakeWorkflowEngineService,
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

  it('sendLoanRaisedNotification dispatches once, straight to the customer', async () => {
    await port.sendLoanRaisedNotification('cust-1', 50_000, 200_000, new Date());

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenCalledWith(
      NotificationTrigger.LOAN_RAISED,
      'cust-1',
      expect.objectContaining({ kind: 'CUSTOMER', id: 'cust-1' }),
      expect.objectContaining({ memberAmountKobo: 50_000, groupCumulativeAmountKobo: 200_000 }),
    );
  });

  it('sendVerificationEscalation resolves involved parties from the Loan record and dispatches once per resolved staff recipient (not one combined job)', async () => {
    const loan = await loanModel.create({
      groupId: new Types.ObjectId(),
      productId: new Types.ObjectId(),
      branchId: new Types.ObjectId(),
      raisedBy: new Types.ObjectId(),
      tenureMonths: 6,
      cumulativeAmountKobo: 200_000,
      status: LoanStatus.APPROVED,
      raisedAt: new Date(),
    });
    resolveInvolvedPartiesSpy.mockResolvedValue(['staff-1', 'staff-2']);

    await port.sendVerificationEscalation(loan._id.toString(), 'cust-1', 'BVN mismatch');

    expect(resolveInvolvedPartiesSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        branchId: loan.branchId.toString(),
        initiatedBy: loan.raisedBy.toString(),
      }),
    );
    // One dispatch call per resolved recipient — never a single combined job.
    expect(dispatchSpy).toHaveBeenCalledTimes(2);
    expect(dispatchSpy).toHaveBeenCalledWith(
      NotificationTrigger.VERIFICATION_ESCALATED,
      loan._id.toString(),
      expect.objectContaining({ id: 'staff-1' }),
      expect.anything(),
    );
    expect(dispatchSpy).toHaveBeenCalledWith(
      NotificationTrigger.VERIFICATION_ESCALATED,
      loan._id.toString(),
      expect.objectContaining({ id: 'staff-2' }),
      expect.anything(),
    );
  });

  it('sendVerificationEscalation sources relatedWorkflowRequestId from the LOAN approval chain history', async () => {
    const loan = await loanModel.create({
      groupId: new Types.ObjectId(),
      productId: new Types.ObjectId(),
      branchId: new Types.ObjectId(),
      raisedBy: new Types.ObjectId(),
      tenureMonths: 6,
      cumulativeAmountKobo: 200_000,
      status: LoanStatus.APPROVED,
      raisedAt: new Date(),
    });
    const requestId = new Types.ObjectId().toString();
    getHistorySpy.mockResolvedValue([{ _id: { toString: () => requestId } }]);
    resolveInvolvedPartiesSpy.mockResolvedValue([]);

    await port.sendVerificationEscalation(loan._id.toString(), 'cust-1', 'reason');

    expect(getHistorySpy).toHaveBeenCalledWith(WorkflowEntityType.LOAN, loan._id.toString());
    expect(resolveInvolvedPartiesSpy).toHaveBeenCalledWith(
      expect.objectContaining({ relatedWorkflowRequestId: requestId }),
    );
  });

  it('sendRepaymentDisputeRaised resolves involved parties with initiatedBy = recordedBy and dispatches once per recipient', async () => {
    resolveInvolvedPartiesSpy.mockResolvedValue(['staff-1']);

    await port.sendRepaymentDisputeRaised({
      repaymentRecordId: 'repayment-1',
      branchId: 'branch-1',
      recordedBy: 'marketer-1',
      raisedBy: 'admin-1',
      reason: 'Amount mismatch',
      relatedWorkflowRequestId: 'workflow-1',
    });

    expect(resolveInvolvedPartiesSpy).toHaveBeenCalledWith({
      branchId: 'branch-1',
      initiatedBy: 'marketer-1',
      relatedWorkflowRequestId: 'workflow-1',
    });
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenCalledWith(
      NotificationTrigger.REPAYMENT_DISPUTED,
      'repayment-1',
      expect.objectContaining({ id: 'staff-1' }),
      expect.objectContaining({ raisedBy: 'admin-1', reason: 'Amount mismatch' }),
    );
  });
});
