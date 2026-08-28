import { EventEmitterModule } from '@nestjs/event-emitter';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model, Types } from 'mongoose';

import { ConfigRecordStatus } from '../../common/enums/platform-config.enums';
import { WorkflowEntityType, WorkflowStepAction } from '../../common/enums/workflow.enums';
import { AuditModule } from '../../platform/audit/audit.module';
import { approveCapability } from '../../platform/rbac/constants/capabilities';
import { ActingStaff } from '../../platform/workflow-engine/interfaces/workflow-engine.interfaces';
import {
  WorkflowChainConfig,
  WorkflowChainConfigDocument,
  WorkflowChainConfigSchema,
} from '../../platform/workflow-engine/schemas/workflow-chain-config.schema';
import { WorkflowRequest, WorkflowRequestSchema } from '../../platform/workflow-engine/schemas/workflow-request.schema';
import { WorkflowEngineService } from '../../platform/workflow-engine/workflow-engine.service';
import { InMemoryMongo } from '../../test-utils/in-memory-mongo';
import { CreateLoanConfigurationDto } from './dto/create-loan-configuration.dto';
import { LoanConfigurationService } from './loan-configuration.service';
import { LoanConfiguration, LoanConfigurationDocument, LoanConfigurationSchema } from './schemas/loan-configuration.schema';

describe('LoanConfigurationService', () => {
  const mongo = new InMemoryMongo();

  let moduleRef: TestingModule;
  let service: LoanConfigurationService;
  let workflowEngineService: WorkflowEngineService;
  let loanConfigurationModel: Model<LoanConfigurationDocument>;
  let chainConfigModel: Model<WorkflowChainConfigDocument>;

  const INITIATOR_ID = new Types.ObjectId().toString();
  const APPROVER_ID = new Types.ObjectId().toString();
  const OTHER_APPROVER_ID = new Types.ObjectId().toString();

  const APPROVE_ACTOR: ActingStaff = {
    staffId: APPROVER_ID,
    capabilities: [approveCapability(WorkflowEntityType.LOAN_CONFIG)],
  };

  beforeAll(async () => {
    await mongo.start();

    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri()),
        MongooseModule.forFeature([
          { name: LoanConfiguration.name, schema: LoanConfigurationSchema },
          { name: WorkflowChainConfig.name, schema: WorkflowChainConfigSchema },
          { name: WorkflowRequest.name, schema: WorkflowRequestSchema },
        ]),
        AuditModule,
        EventEmitterModule.forRoot(),
      ],
      providers: [LoanConfigurationService, WorkflowEngineService],
    }).compile();

    service = moduleRef.get(LoanConfigurationService);
    workflowEngineService = moduleRef.get(WorkflowEngineService);
    loanConfigurationModel = moduleRef.get(getModelToken(LoanConfiguration.name));
    chainConfigModel = moduleRef.get(getModelToken(WorkflowChainConfig.name));

    await moduleRef.init();
  }, 60_000);

  afterEach(async () => {
    const collectionsToKeep = new Set(['workflow_chain_configs']);
    const connection = loanConfigurationModel.db;
    const collections = await connection.db!.collections();
    await Promise.all(
      collections.filter((c) => !collectionsToKeep.has(c.collectionName)).map((c) => c.deleteMany({})),
    );
  });

  afterAll(async () => {
    await moduleRef.close();
    await mongo.stop();
  });

  function dto(overrides: Partial<CreateLoanConfigurationDto> = {}): CreateLoanConfigurationDto {
    return {
      interestRate: 2_400,
      maxLoanAmountKobo: 500_000_00,
      minLoanAmountKobo: 5_000_00,
      maxTenureMonths: 24,
      gracePeriodDays: 7,
      maxGroupSize: 15,
      minGroupSize: 5,
      ...overrides,
    };
  }

  async function approve(requestId: string, actor: ActingStaff = APPROVE_ACTOR): Promise<void> {
    await workflowEngineService.act({
      workflowRequestId: requestId,
      actor,
      action: WorkflowStepAction.APPROVED,
    });
  }

  it('registers a single-step (approve-only) CREATE chain on module init', async () => {
    const config = await chainConfigModel
      .findOne({ entityType: WorkflowEntityType.LOAN_CONFIG, action: 'CREATE' })
      .exec();
    expect(config?.steps).toHaveLength(1);
    expect(config?.steps[0]?.requiredCapability).toBe(approveCapability(WorkflowEntityType.LOAN_CONFIG));
  });

  it('proposing a version creates nothing until approved', async () => {
    const request = await service.initiateCreation(dto(), INITIATOR_ID);
    expect(request.status).toBe('PENDING_APPROVAL');
    expect(await loanConfigurationModel.countDocuments().exec()).toBe(0);
  });

  it('the maker of a proposal cannot approve their own proposal', async () => {
    const request = await service.initiateCreation(dto(), INITIATOR_ID);
    await expect(
      workflowEngineService.act({
        workflowRequestId: request._id.toString(),
        actor: { staffId: INITIATOR_ID, capabilities: [approveCapability(WorkflowEntityType.LOAN_CONFIG)] },
        action: WorkflowStepAction.APPROVED,
      }),
    ).rejects.toThrow(/cannot act on their own request/);
  });

  it('on approval, creates an ACTIVE record stamped with proposer/approver and links the WorkflowRequest to it', async () => {
    const request = await service.initiateCreation(dto({ interestRate: 1_999 }), INITIATOR_ID);
    await approve(request._id.toString());

    const active = await service.findActive();
    expect(active).not.toBeNull();
    expect(active!.interestRate).toBe(1_999);
    expect(active!.status).toBe(ConfigRecordStatus.ACTIVE);
    expect(active!.proposedBy.toString()).toBe(INITIATOR_ID);
    expect(active!.approvedBy.toString()).toBe(APPROVER_ID);
    expect(active!.proposedAt).toBeInstanceOf(Date);
    expect(active!.approvedAt).toBeInstanceOf(Date);

    const linked = await workflowEngineService.getById(request._id.toString());
    expect(linked.entityId).toBe(active!._id.toString());
  });

  it('approving a second proposal supersedes the first — only the newest is ACTIVE, the old one flips to INACTIVE', async () => {
    const firstRequest = await service.initiateCreation(dto({ interestRate: 1_500 }), INITIATOR_ID);
    await approve(firstRequest._id.toString());
    const first = await service.findActive();

    const secondRequest = await service.initiateCreation(dto({ interestRate: 3_000 }), INITIATOR_ID);
    await approve(secondRequest._id.toString(), {
      staffId: OTHER_APPROVER_ID,
      capabilities: [approveCapability(WorkflowEntityType.LOAN_CONFIG)],
    });

    const active = await service.findActive();
    expect(active!.interestRate).toBe(3_000);

    const supersededFirst = await service.findById(first!._id.toString());
    expect(supersededFirst!.status).toBe(ConfigRecordStatus.INACTIVE);

    const all = await service.findAll();
    expect(all).toHaveLength(2);
    expect(all.filter((r) => r.status === ConfigRecordStatus.ACTIVE)).toHaveLength(1);
  });

  it('a rejected proposal never creates a record', async () => {
    const request = await service.initiateCreation(dto(), INITIATOR_ID);
    await workflowEngineService.act({
      workflowRequestId: request._id.toString(),
      actor: APPROVE_ACTOR,
      action: WorkflowStepAction.REJECTED,
      comment: 'not now',
    });

    expect(await service.findActive()).toBeNull();
    expect(await loanConfigurationModel.countDocuments().exec()).toBe(0);
  });
});
