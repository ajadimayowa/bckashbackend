import { EventEmitterModule } from '@nestjs/event-emitter';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model, Types } from 'mongoose';

import {
  FeeAppliesTo,
  FeeCalcType,
  FeeCategory,
  FeePercentageBasis,
  FeeTiming,
} from '../../common/enums/loan-product.enums';
import { WorkflowEntityType, WorkflowStepAction } from '../../common/enums/workflow.enums';
import { InMemoryMongo } from '../../test-utils/in-memory-mongo';
import { AuditModule } from '../../platform/audit/audit.module';
import { approveCapability } from '../../platform/rbac/constants/capabilities';
import { ActingStaff } from '../../platform/workflow-engine/interfaces/workflow-engine.interfaces';
import {
  WorkflowChainConfig,
  WorkflowChainConfigDocument,
  WorkflowChainConfigSchema,
} from '../../platform/workflow-engine/schemas/workflow-chain-config.schema';
import {
  WorkflowRequest,
  WorkflowRequestSchema,
} from '../../platform/workflow-engine/schemas/workflow-request.schema';
import { WorkflowEngineService } from '../../platform/workflow-engine/workflow-engine.service';
import { CreateFeeDefinitionDto } from './dto/create-fee-definition.dto';
import { FeeDefinitionsService } from './fee-definitions.service';
import {
  FeeDefinition,
  FeeDefinitionDocument,
  FeeDefinitionSchema,
} from './schemas/fee-definition.schema';

describe('FeeDefinitionsService', () => {
  const mongo = new InMemoryMongo();

  let moduleRef: TestingModule;
  let service: FeeDefinitionsService;
  let workflowEngineService: WorkflowEngineService;
  let feeDefinitionModel: Model<FeeDefinitionDocument>;
  let chainConfigModel: Model<WorkflowChainConfigDocument>;

  const INITIATOR_ID = new Types.ObjectId().toString();
  const APPROVER_ID = new Types.ObjectId().toString();

  const APPROVE_ACTOR: ActingStaff = {
    staffId: APPROVER_ID,
    capabilities: [approveCapability(WorkflowEntityType.FEE_DEFINITION)],
  };

  beforeAll(async () => {
    await mongo.start();

    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri()),
        MongooseModule.forFeature([
          { name: FeeDefinition.name, schema: FeeDefinitionSchema },
          { name: WorkflowChainConfig.name, schema: WorkflowChainConfigSchema },
          { name: WorkflowRequest.name, schema: WorkflowRequestSchema },
        ]),
        AuditModule,
        EventEmitterModule.forRoot(),
      ],
      providers: [FeeDefinitionsService, WorkflowEngineService],
    }).compile();

    service = moduleRef.get(FeeDefinitionsService);
    workflowEngineService = moduleRef.get(WorkflowEngineService);
    feeDefinitionModel = moduleRef.get(getModelToken(FeeDefinition.name));
    chainConfigModel = moduleRef.get(getModelToken(WorkflowChainConfig.name));

    await moduleRef.init(); // registers @OnEvent listeners + chain configs
  }, 60_000);

  afterEach(async () => {
    const collectionsToKeep = new Set(['workflow_chain_configs']);
    const connection = feeDefinitionModel.db;
    const collections = await connection.db!.collections();
    await Promise.all(
      collections
        .filter((c) => !collectionsToKeep.has(c.collectionName))
        .map((c) => c.deleteMany({})),
    );
  });

  afterAll(async () => {
    await moduleRef.close();
    await mongo.stop();
  });

  function fixedDto(overrides: Partial<CreateFeeDefinitionDto> = {}): CreateFeeDefinitionDto {
    return {
      name: 'Registration Fee',
      category: FeeCategory.REGISTRATION,
      timing: FeeTiming.PRE_LOAN,
      calcType: FeeCalcType.FIXED,
      value: 2_000,
      appliesTo: FeeAppliesTo.PER_MEMBER,
      ...overrides,
    };
  }

  async function approve(requestId: string): Promise<void> {
    await workflowEngineService.act({
      workflowRequestId: requestId,
      actor: APPROVE_ACTOR,
      action: WorkflowStepAction.APPROVED,
    });
  }

  it('registers a single-step (approve-only) chain for both CREATE and UPDATE', async () => {
    const createConfig = await chainConfigModel
      .findOne({ entityType: WorkflowEntityType.FEE_DEFINITION, action: 'CREATE' })
      .exec();
    const updateConfig = await chainConfigModel
      .findOne({ entityType: WorkflowEntityType.FEE_DEFINITION, action: 'UPDATE' })
      .exec();
    expect(createConfig?.steps).toHaveLength(1);
    expect(updateConfig?.steps).toHaveLength(1);
    expect(createConfig?.steps[0]?.requiredCapability).toBe(
      approveCapability(WorkflowEntityType.FEE_DEFINITION),
    );
  });

  describe('initiateCreation', () => {
    it('does not persist a FeeDefinition until approved; rejection leaves nothing behind', async () => {
      const request = await service.initiateCreation(fixedDto(), INITIATOR_ID);
      expect(await feeDefinitionModel.countDocuments()).toBe(0);

      await workflowEngineService.act({
        workflowRequestId: request._id.toString(),
        actor: APPROVE_ACTOR,
        action: WorkflowStepAction.REJECTED,
        comment: 'not needed',
      });

      expect(await feeDefinitionModel.countDocuments()).toBe(0);
    });

    it('creates the FeeDefinition with the expected fields on approval', async () => {
      const request = await service.initiateCreation(fixedDto({ name: 'Form Fee' }), INITIATOR_ID);
      await approve(request._id.toString());

      const created = await feeDefinitionModel.findOne({ name: 'Form Fee' }).exec();
      expect(created).not.toBeNull();
      expect(created?.calcType).toBe(FeeCalcType.FIXED);
      expect(created?.value).toBe(2_000);
      expect(created?.active).toBe(true);
      expect(created?.percentageOf).toBeNull();
    });

    it('requires percentageOf when calcType is PERCENTAGE', async () => {
      await expect(
        service.initiateCreation(
          fixedDto({ calcType: FeeCalcType.PERCENTAGE, value: 500, percentageOf: undefined }),
          INITIATOR_ID,
        ),
      ).rejects.toThrow(/percentageOf/);
    });

    it('normalizes (ignores) a supplied percentageOf when calcType is FIXED', async () => {
      const request = await service.initiateCreation(
        fixedDto({ name: 'Ignore Basis', percentageOf: FeePercentageBasis.PRINCIPAL }),
        INITIATOR_ID,
      );
      await approve(request._id.toString());

      const created = await feeDefinitionModel.findOne({ name: 'Ignore Basis' }).exec();
      expect(created?.percentageOf).toBeNull();
    });

    it('persists a PERCENTAGE fee with its percentageOf correctly', async () => {
      const request = await service.initiateCreation(
        fixedDto({
          name: 'Late Repayment Fee',
          category: FeeCategory.LATE_REPAYMENT,
          calcType: FeeCalcType.PERCENTAGE,
          value: 500,
          percentageOf: FeePercentageBasis.OVERDUE_AMOUNT,
        }),
        INITIATOR_ID,
      );
      await approve(request._id.toString());

      const created = await feeDefinitionModel.findOne({ name: 'Late Repayment Fee' }).exec();
      expect(created?.calcType).toBe(FeeCalcType.PERCENTAGE);
      expect(created?.percentageOf).toBe(FeePercentageBasis.OVERDUE_AMOUNT);
    });
  });

  describe('initiateUpdate', () => {
    async function createApprovedFee(): Promise<string> {
      const request = await service.initiateCreation(fixedDto({ name: 'Base Fee' }), INITIATOR_ID);
      await approve(request._id.toString());
      const created = await feeDefinitionModel.findOne({ name: 'Base Fee' }).exec();
      return created!._id.toString();
    }

    it('a partial update of just `name` does not touch percentageOf/calcType', async () => {
      const feeId = await createApprovedFee();
      const request = await service.initiateUpdate(feeId, { name: 'Renamed Fee' }, INITIATOR_ID);
      await approve(request._id.toString());

      const updated = await feeDefinitionModel.findById(feeId).exec();
      expect(updated?.name).toBe('Renamed Fee');
      expect(updated?.calcType).toBe(FeeCalcType.FIXED);
      expect(updated?.percentageOf).toBeNull();
    });

    it('rejects switching calcType to PERCENTAGE without a percentageOf', async () => {
      const feeId = await createApprovedFee();
      await expect(
        service.initiateUpdate(feeId, { calcType: FeeCalcType.PERCENTAGE }, INITIATOR_ID),
      ).rejects.toThrow(/percentageOf/);
    });

    it('does not apply the update until approved', async () => {
      const feeId = await createApprovedFee();
      await service.initiateUpdate(feeId, { active: false }, INITIATOR_ID);

      const stillUnchanged = await feeDefinitionModel.findById(feeId).exec();
      expect(stillUnchanged?.active).toBe(true);
    });
  });

  describe('assertFeesExistAndActive', () => {
    it('resolves silently when every id exists and is active', async () => {
      const feeId = await (async () => {
        const request = await service.initiateCreation(
          fixedDto({ name: 'Active Fee' }),
          INITIATOR_ID,
        );
        await approve(request._id.toString());
        const created = await feeDefinitionModel.findOne({ name: 'Active Fee' }).exec();
        return created!._id.toString();
      })();

      await expect(service.assertFeesExistAndActive([feeId])).resolves.toBeUndefined();
    });

    it('throws when a feeId does not exist', async () => {
      await expect(
        service.assertFeesExistAndActive([new Types.ObjectId().toString()]),
      ).rejects.toThrow(/do not exist|not.*active/);
    });

    it('throws when a feeId exists but is not active', async () => {
      const request = await service.initiateCreation(
        fixedDto({ name: 'Inactive Fee' }),
        INITIATOR_ID,
      );
      await approve(request._id.toString());
      const created = await feeDefinitionModel.findOne({ name: 'Inactive Fee' }).exec();
      await feeDefinitionModel.updateOne({ _id: created!._id }, { $set: { active: false } }).exec();

      await expect(service.assertFeesExistAndActive([created!._id.toString()])).rejects.toThrow(
        /do not exist|not.*active/,
      );
    });

    it('is a no-op for an empty array', async () => {
      await expect(service.assertFeesExistAndActive([])).resolves.toBeUndefined();
    });
  });
});
