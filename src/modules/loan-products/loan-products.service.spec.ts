import { EventEmitterModule } from '@nestjs/event-emitter';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model, Types } from 'mongoose';

import {
  FeeAppliesTo,
  FeeCalcType,
  FeeCategory,
  FeeTiming,
  InterestType,
  PenaltyFrequency,
  ProductStatus,
} from '../../common/enums/loan-product.enums';
import { WorkflowEntityType, WorkflowStepAction } from '../../common/enums/workflow.enums';
import { InMemoryMongo } from '../../test-utils/in-memory-mongo';
import { AuditModule } from '../../platform/audit/audit.module';
import { approveCapability, reviewCapability } from '../../platform/rbac/constants/capabilities';
import { ActingStaff } from '../../platform/workflow-engine/interfaces/workflow-engine.interfaces';
import {
  WorkflowChainConfig,
  WorkflowChainConfigDocument,
  WorkflowChainConfigSchema,
} from '../../platform/workflow-engine/schemas/workflow-chain-config.schema';
import {
  WorkflowRequest,
  WorkflowRequestDocument,
  WorkflowRequestSchema,
} from '../../platform/workflow-engine/schemas/workflow-request.schema';
import { WorkflowEngineService } from '../../platform/workflow-engine/workflow-engine.service';
import { CreateFeeDefinitionDto } from './dto/create-fee-definition.dto';
import { CreateLoanProductDto } from './dto/create-loan-product.dto';
import { FeeDefinitionsService } from './fee-definitions.service';
import { loanApprovalActionFor, LoanProductsService } from './loan-products.service';
import {
  FeeDefinition,
  FeeDefinitionDocument,
  FeeDefinitionSchema,
} from './schemas/fee-definition.schema';
import { LoanProduct, LoanProductDocument, LoanProductSchema } from './schemas/loan-product.schema';

describe('LoanProductsService', () => {
  const mongo = new InMemoryMongo();

  let moduleRef: TestingModule;
  let service: LoanProductsService;
  let feeDefinitionsService: FeeDefinitionsService;
  let workflowEngineService: WorkflowEngineService;
  let loanProductModel: Model<LoanProductDocument>;
  let feeDefinitionModel: Model<FeeDefinitionDocument>;
  let chainConfigModel: Model<WorkflowChainConfigDocument>;
  let workflowRequestModel: Model<WorkflowRequestDocument>;

  const INITIATOR_ID = new Types.ObjectId().toString();
  const APPROVER_ID = new Types.ObjectId().toString();

  const APPROVE_PRODUCT_ACTOR: ActingStaff = {
    staffId: APPROVER_ID,
    capabilities: [approveCapability(WorkflowEntityType.LOAN_PRODUCT)],
  };

  beforeAll(async () => {
    await mongo.start();

    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri()),
        MongooseModule.forFeature([
          { name: LoanProduct.name, schema: LoanProductSchema },
          { name: FeeDefinition.name, schema: FeeDefinitionSchema },
          { name: WorkflowChainConfig.name, schema: WorkflowChainConfigSchema },
          { name: WorkflowRequest.name, schema: WorkflowRequestSchema },
        ]),
        AuditModule,
        EventEmitterModule.forRoot(),
      ],
      providers: [LoanProductsService, FeeDefinitionsService, WorkflowEngineService],
    }).compile();

    service = moduleRef.get(LoanProductsService);
    feeDefinitionsService = moduleRef.get(FeeDefinitionsService);
    workflowEngineService = moduleRef.get(WorkflowEngineService);
    loanProductModel = moduleRef.get(getModelToken(LoanProduct.name));
    feeDefinitionModel = moduleRef.get(getModelToken(FeeDefinition.name));
    chainConfigModel = moduleRef.get(getModelToken(WorkflowChainConfig.name));
    workflowRequestModel = moduleRef.get(getModelToken(WorkflowRequest.name));

    await moduleRef.init();
  }, 60_000);

  afterEach(async () => {
    const collectionsToKeep = new Set(['workflow_chain_configs']);
    const connection = loanProductModel.db;
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

  function productDto(overrides: Partial<CreateLoanProductDto> = {}): CreateLoanProductDto {
    return {
      name: `Product-${Date.now()}-${Math.random()}`,
      interestRate: 1_800,
      interestType: InterestType.REDUCING,
      tenureOptions: [14, 30, 60],
      minGroupSize: 3,
      feeIds: [],
      approvalChainSteps: [
        { order: 0, requiredCapability: reviewCapability(WorkflowEntityType.LOAN) },
        { order: 1, requiredCapability: approveCapability(WorkflowEntityType.LOAN) },
      ],
      penaltyRule: {
        calcType: FeeCalcType.FIXED,
        value: 1_000,
        gracePeriodDays: 5,
        frequency: PenaltyFrequency.ONE_TIME,
      },
      ...overrides,
    };
  }

  function feeDto(overrides: Partial<CreateFeeDefinitionDto> = {}): CreateFeeDefinitionDto {
    return {
      name: `Fee-${Date.now()}-${Math.random()}`,
      category: FeeCategory.REGISTRATION,
      timing: FeeTiming.PRE_LOAN,
      calcType: FeeCalcType.FIXED,
      value: 500,
      appliesTo: FeeAppliesTo.PER_MEMBER,
      ...overrides,
    };
  }

  async function approveProduct(requestId: string): Promise<void> {
    await workflowEngineService.act({
      workflowRequestId: requestId,
      actor: APPROVE_PRODUCT_ACTOR,
      action: WorkflowStepAction.APPROVED,
    });
  }

  async function createApprovedFee(): Promise<string> {
    const dto = feeDto();
    const request = await feeDefinitionsService.initiateCreation(dto, INITIATOR_ID);
    await workflowEngineService.act({
      workflowRequestId: request._id.toString(),
      actor: {
        staffId: APPROVER_ID,
        capabilities: [approveCapability(WorkflowEntityType.FEE_DEFINITION)],
      },
      action: WorkflowStepAction.APPROVED,
    });
    const created = await feeDefinitionModel.findOne({ name: dto.name }).exec();
    return created!._id.toString();
  }

  async function createApprovedProduct(
    overrides: Partial<CreateLoanProductDto> = {},
  ): Promise<LoanProductDocument> {
    const dto = productDto(overrides);
    const request = await service.initiateCreation(dto, INITIATOR_ID);
    await approveProduct(request._id.toString());
    const created = await loanProductModel.findOne({ name: dto.name }).exec();
    return created!;
  }

  it('registers a single-step (approve-only) chain for both CREATE and UPDATE', async () => {
    const createConfig = await chainConfigModel
      .findOne({ entityType: WorkflowEntityType.LOAN_PRODUCT, action: 'CREATE' })
      .exec();
    const updateConfig = await chainConfigModel
      .findOne({ entityType: WorkflowEntityType.LOAN_PRODUCT, action: 'UPDATE' })
      .exec();
    expect(createConfig?.steps).toHaveLength(1);
    expect(updateConfig?.steps).toHaveLength(1);
  });

  describe('initiateCreation validation', () => {
    it('rejects minGroupSize < 3', async () => {
      await expect(
        service.initiateCreation(productDto({ minGroupSize: 2 }), INITIATOR_ID),
      ).rejects.toThrow(/at least 3/);
    });

    it('rejects a tenureOptions entry below the 14-day floor', async () => {
      await expect(
        service.initiateCreation(productDto({ tenureOptions: [13, 30] }), INITIATOR_ID),
      ).rejects.toThrow(/at least 14 days/);
    });

    it('rejects a feeIds entry that does not exist', async () => {
      await expect(
        service.initiateCreation(
          productDto({ feeIds: [new Types.ObjectId().toString()] }),
          INITIATOR_ID,
        ),
      ).rejects.toThrow(/do not exist|not.*active/);
    });

    it('rejects a feeIds entry that exists but is not active', async () => {
      const feeId = await createApprovedFee();
      await feeDefinitionModel.updateOne({ _id: feeId }, { $set: { active: false } }).exec();

      await expect(
        service.initiateCreation(productDto({ feeIds: [feeId] }), INITIATOR_ID),
      ).rejects.toThrow(/do not exist|not.*active/);
    });

    it('accepts an existing, active feeId', async () => {
      const feeId = await createApprovedFee();
      const request = await service.initiateCreation(productDto({ feeIds: [feeId] }), INITIATOR_ID);
      expect(request).toBeDefined();
    });

    it('rejects an approvalChainSteps entry whose capability is not in the known RBAC capability set', async () => {
      await expect(
        service.initiateCreation(
          productDto({
            approvalChainSteps: [{ order: 0, requiredCapability: 'workflow:aproove:LOAN' }], // typo
          }),
          INITIATOR_ID,
        ),
      ).rejects.toThrow(/unknown capability/);
    });

    it('rejects an empty approvalChainSteps', async () => {
      await expect(
        service.initiateCreation(productDto({ approvalChainSteps: [] }), INITIATOR_ID),
      ).rejects.toThrow(/must not be empty/);
    });

    it('rejects a non-contiguous approvalChainSteps order', async () => {
      await expect(
        service.initiateCreation(
          productDto({
            approvalChainSteps: [
              { order: 0, requiredCapability: approveCapability(WorkflowEntityType.LOAN) },
              { order: 2, requiredCapability: approveCapability(WorkflowEntityType.LOAN) },
            ],
          }),
          INITIATOR_ID,
        ),
      ).rejects.toThrow(/contiguous/);
    });

    it('rejects a PERCENTAGE penaltyRule with no percentageOf', async () => {
      await expect(
        service.initiateCreation(
          productDto({
            penaltyRule: {
              calcType: FeeCalcType.PERCENTAGE,
              value: 500,
              gracePeriodDays: 5,
              frequency: PenaltyFrequency.ONE_TIME,
            },
          }),
          INITIATOR_ID,
        ),
      ).rejects.toThrow(/percentageOf/);
    });
  });

  describe('creation lifecycle', () => {
    it('does not persist a LoanProduct until approved; rejection leaves nothing behind', async () => {
      const dto = productDto();
      const request = await service.initiateCreation(dto, INITIATOR_ID);
      expect(await loanProductModel.countDocuments({ name: dto.name })).toBe(0);

      await workflowEngineService.act({
        workflowRequestId: request._id.toString(),
        actor: APPROVE_PRODUCT_ACTOR,
        action: WorkflowStepAction.REJECTED,
        comment: 'not needed',
      });

      expect(await loanProductModel.countDocuments({ name: dto.name })).toBe(0);
    });

    it('creates the LoanProduct with the expected fields on approval', async () => {
      const product = await createApprovedProduct({ interestRate: 2_200 });
      expect(product.status).toBe('ACTIVE');
      expect(product.interestRate).toBe(2_200);
      expect(product.approvalChainSteps).toHaveLength(2);
    });

    it('registers the dynamic LOAN/APPROVE_<productId> chain config with the product exact approvalChainSteps on approval', async () => {
      const product = await createApprovedProduct();
      const chain = await chainConfigModel
        .findOne({
          entityType: WorkflowEntityType.LOAN,
          action: loanApprovalActionFor(product._id.toString()),
        })
        .exec();

      expect(chain).not.toBeNull();
      expect(chain?.steps).toHaveLength(2);
      expect(chain?.steps.map((s) => s.requiredCapability)).toEqual([
        reviewCapability(WorkflowEntityType.LOAN),
        approveCapability(WorkflowEntityType.LOAN),
      ]);
    });
  });

  describe('update lifecycle', () => {
    it('does not apply the update until approved', async () => {
      const product = await createApprovedProduct();
      await service.initiateUpdate(product._id.toString(), { interestRate: 999 }, INITIATOR_ID);

      const stillUnchanged = await loanProductModel.findById(product._id).exec();
      expect(stillUnchanged?.interestRate).toBe(product.interestRate);
    });

    it('rejects an update with minGroupSize < 3', async () => {
      const product = await createApprovedProduct();
      await expect(
        service.initiateUpdate(product._id.toString(), { minGroupSize: 1 }, INITIATOR_ID),
      ).rejects.toThrow(/at least 3/);
    });

    it('rejects an update with a tenureOptions entry below the 14-day floor', async () => {
      const product = await createApprovedProduct();
      await expect(
        service.initiateUpdate(product._id.toString(), { tenureOptions: [7] }, INITIATOR_ID),
      ).rejects.toThrow(/at least 14 days/);
    });

    it(
      'updating approvalChainSteps re-registers the LOAN/APPROVE_<productId> chain for FUTURE ' +
        'loan applications, but does NOT alter the steps snapshot already inside an in-flight WorkflowRequest',
      async () => {
        const product = await createApprovedProduct();
        const productId = product._id.toString();
        const action = loanApprovalActionFor(productId);

        // Simulate a loan application already mid-approval under the OLD chain shape.
        const inFlightRequest = await workflowEngineService.initiate({
          entityType: WorkflowEntityType.LOAN,
          action,
          payload: { simulated: true },
          initiatedBy: INITIATOR_ID,
        });
        const originalSteps = inFlightRequest.steps.map((s) => s.requiredCapability);
        expect(originalSteps).toEqual([
          reviewCapability(WorkflowEntityType.LOAN),
          approveCapability(WorkflowEntityType.LOAN),
        ]);

        // Admin updates the product's approval chain to a single step.
        const newSteps = [
          { order: 0, requiredCapability: approveCapability(WorkflowEntityType.LOAN) },
        ];
        const updateRequest = await service.initiateUpdate(
          productId,
          { approvalChainSteps: newSteps },
          INITIATOR_ID,
        );
        await approveProduct(updateRequest._id.toString());

        // The chain config used for FUTURE loan applications reflects the new shape.
        const chainAfterUpdate = await chainConfigModel
          .findOne({ entityType: WorkflowEntityType.LOAN, action })
          .exec();
        expect(chainAfterUpdate?.steps).toHaveLength(1);
        expect(chainAfterUpdate?.steps[0]?.requiredCapability).toBe(
          approveCapability(WorkflowEntityType.LOAN),
        );

        // The IN-FLIGHT request's own snapshot is completely untouched.
        const reloadedInFlight = await workflowRequestModel.findById(inFlightRequest._id).exec();
        expect(reloadedInFlight?.steps.map((s) => s.requiredCapability)).toEqual(originalSteps);
        expect(reloadedInFlight?.steps).toHaveLength(2);

        // A NEW loan application initiated after the update gets the new (1-step) chain.
        const newRequest = await workflowEngineService.initiate({
          entityType: WorkflowEntityType.LOAN,
          action,
          payload: { simulated: true },
          initiatedBy: INITIATOR_ID,
        });
        expect(newRequest.steps).toHaveLength(1);
        expect(newRequest.steps[0]?.requiredCapability).toBe(
          approveCapability(WorkflowEntityType.LOAN),
        );
      },
    );
  });

  describe('reads', () => {
    it('findByIdOrThrow throws NotFoundException for an unknown id', async () => {
      await expect(service.findByIdOrThrow(new Types.ObjectId().toString())).rejects.toThrow(
        /not found/,
      );
    });

    it('findAll filters by status', async () => {
      await createApprovedProduct();
      const active = await service.findAll({ status: ProductStatus.ACTIVE });
      expect(active.length).toBeGreaterThan(0);
    });
  });
});
