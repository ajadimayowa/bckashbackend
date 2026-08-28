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
import { BranchRulesConfigurationService } from './branch-rules-configuration.service';
import { CreateBranchRulesConfigurationDto } from './dto/create-branch-rules-configuration.dto';
import {
  BranchRulesConfiguration,
  BranchRulesConfigurationDocument,
  BranchRulesConfigurationSchema,
} from './schemas/branch-rules-configuration.schema';

describe('BranchRulesConfigurationService', () => {
  const mongo = new InMemoryMongo();

  let moduleRef: TestingModule;
  let service: BranchRulesConfigurationService;
  let workflowEngineService: WorkflowEngineService;
  let model: Model<BranchRulesConfigurationDocument>;
  let chainConfigModel: Model<WorkflowChainConfigDocument>;

  const INITIATOR_ID = new Types.ObjectId().toString();
  const APPROVER_ID = new Types.ObjectId().toString();

  const APPROVE_ACTOR: ActingStaff = {
    staffId: APPROVER_ID,
    capabilities: [approveCapability(WorkflowEntityType.BRANCH_RULES_CONFIG)],
  };

  beforeAll(async () => {
    await mongo.start();

    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri()),
        MongooseModule.forFeature([
          { name: BranchRulesConfiguration.name, schema: BranchRulesConfigurationSchema },
          { name: WorkflowChainConfig.name, schema: WorkflowChainConfigSchema },
          { name: WorkflowRequest.name, schema: WorkflowRequestSchema },
        ]),
        AuditModule,
        EventEmitterModule.forRoot(),
      ],
      providers: [BranchRulesConfigurationService, WorkflowEngineService],
    }).compile();

    service = moduleRef.get(BranchRulesConfigurationService);
    workflowEngineService = moduleRef.get(WorkflowEngineService);
    model = moduleRef.get(getModelToken(BranchRulesConfiguration.name));
    chainConfigModel = moduleRef.get(getModelToken(WorkflowChainConfig.name));

    await moduleRef.init();
  }, 60_000);

  afterAll(async () => {
    await moduleRef.close();
    await mongo.stop();
  });

  function dto(overrides: Partial<CreateBranchRulesConfigurationDto> = {}): CreateBranchRulesConfigurationDto {
    return {
      maxActiveBranches: 20,
      defaultFundLimitKobo: 5_000_000_00,
      requireManagerApproval: true,
      autoDisbursementLimitKobo: 500_000_00,
      ...overrides,
    };
  }

  it('registers a single-step (approve-only) CREATE chain on module init', async () => {
    const config = await chainConfigModel
      .findOne({ entityType: WorkflowEntityType.BRANCH_RULES_CONFIG, action: 'CREATE' })
      .exec();
    expect(config?.steps).toHaveLength(1);
  });

  it('on approval, creates an ACTIVE record with the proposed fields', async () => {
    const request = await service.initiateCreation(dto({ maxActiveBranches: 30 }), INITIATOR_ID);
    await workflowEngineService.act({
      workflowRequestId: request._id.toString(),
      actor: APPROVE_ACTOR,
      action: WorkflowStepAction.APPROVED,
    });

    const active = await service.findActive();
    expect(active).not.toBeNull();
    expect(active!.maxActiveBranches).toBe(30);
    expect(active!.status).toBe(ConfigRecordStatus.ACTIVE);
    expect(active!.approvedBy.toString()).toBe(APPROVER_ID);

    expect(await model.countDocuments().exec()).toBe(1);
  });
});
