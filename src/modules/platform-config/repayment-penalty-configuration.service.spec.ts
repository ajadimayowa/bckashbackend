import { EventEmitterModule } from '@nestjs/event-emitter';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model, Types } from 'mongoose';

import { ConfigRecordStatus, RepaymentFrequency } from '../../common/enums/platform-config.enums';
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
import { CreateRepaymentPenaltyConfigurationDto } from './dto/create-repayment-penalty-configuration.dto';
import { RepaymentPenaltyConfigurationService } from './repayment-penalty-configuration.service';
import {
  RepaymentPenaltyConfiguration,
  RepaymentPenaltyConfigurationDocument,
  RepaymentPenaltyConfigurationSchema,
} from './schemas/repayment-penalty-configuration.schema';

describe('RepaymentPenaltyConfigurationService', () => {
  const mongo = new InMemoryMongo();

  let moduleRef: TestingModule;
  let service: RepaymentPenaltyConfigurationService;
  let workflowEngineService: WorkflowEngineService;
  let model: Model<RepaymentPenaltyConfigurationDocument>;
  let chainConfigModel: Model<WorkflowChainConfigDocument>;

  const INITIATOR_ID = new Types.ObjectId().toString();
  const APPROVER_ID = new Types.ObjectId().toString();

  const APPROVE_ACTOR: ActingStaff = {
    staffId: APPROVER_ID,
    capabilities: [approveCapability(WorkflowEntityType.REPAYMENT_PENALTY_CONFIG)],
  };

  beforeAll(async () => {
    await mongo.start();

    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri()),
        MongooseModule.forFeature([
          { name: RepaymentPenaltyConfiguration.name, schema: RepaymentPenaltyConfigurationSchema },
          { name: WorkflowChainConfig.name, schema: WorkflowChainConfigSchema },
          { name: WorkflowRequest.name, schema: WorkflowRequestSchema },
        ]),
        AuditModule,
        EventEmitterModule.forRoot(),
      ],
      providers: [RepaymentPenaltyConfigurationService, WorkflowEngineService],
    }).compile();

    service = moduleRef.get(RepaymentPenaltyConfigurationService);
    workflowEngineService = moduleRef.get(WorkflowEngineService);
    model = moduleRef.get(getModelToken(RepaymentPenaltyConfiguration.name));
    chainConfigModel = moduleRef.get(getModelToken(WorkflowChainConfig.name));

    await moduleRef.init();
  }, 60_000);

  afterAll(async () => {
    await moduleRef.close();
    await mongo.stop();
  });

  function dto(overrides: Partial<CreateRepaymentPenaltyConfigurationDto> = {}): CreateRepaymentPenaltyConfigurationDto {
    return {
      penaltyRate: 250,
      penaltyGracePeriodDays: 3,
      maxPenaltyCap: 2_500,
      autoPenalty: true,
      repaymentFrequency: RepaymentFrequency.MONTHLY,
      ...overrides,
    };
  }

  it('registers a single-step (approve-only) CREATE chain on module init', async () => {
    const config = await chainConfigModel
      .findOne({ entityType: WorkflowEntityType.REPAYMENT_PENALTY_CONFIG, action: 'CREATE' })
      .exec();
    expect(config?.steps).toHaveLength(1);
  });

  it('on approval, creates an ACTIVE record with the proposed fields', async () => {
    const request = await service.initiateCreation(dto({ repaymentFrequency: RepaymentFrequency.WEEKLY }), INITIATOR_ID);
    await workflowEngineService.act({
      workflowRequestId: request._id.toString(),
      actor: APPROVE_ACTOR,
      action: WorkflowStepAction.APPROVED,
    });

    const active = await service.findActive();
    expect(active).not.toBeNull();
    expect(active!.repaymentFrequency).toBe(RepaymentFrequency.WEEKLY);
    expect(active!.status).toBe(ConfigRecordStatus.ACTIVE);
    expect(active!.approvedBy.toString()).toBe(APPROVER_ID);

    expect(await model.countDocuments().exec()).toBe(1);
  });
});
