import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import {
  FeeCalcType,
  InterestType,
  PenaltyPercentageBasis,
  ProductStatus,
} from '../../common/enums/loan-product.enums';
import { WorkflowEntityType } from '../../common/enums/workflow.enums';
import { AuditService } from '../../platform/audit/audit.service';
import {
  ALL_KNOWN_CAPABILITIES,
  approveCapability,
} from '../../platform/rbac/constants/capabilities';
import {
  WORKFLOW_APPROVED_EVENT,
  WorkflowApprovedEvent,
} from '../../platform/workflow-engine/events/workflow-engine.events';
import { WorkflowRequestDocument } from '../../platform/workflow-engine/schemas/workflow-request.schema';
import { WorkflowEngineService } from '../../platform/workflow-engine/workflow-engine.service';
import { CreateLoanProductDto } from './dto/create-loan-product.dto';
import { PenaltyRuleDto } from './dto/penalty-rule.dto';
import { UpdateLoanProductDto } from './dto/update-loan-product.dto';
import { FeeDefinitionsService } from './fee-definitions.service';
import { LoanProduct, LoanProductDocument, PenaltyRule } from './schemas/loan-product.schema';

const PRODUCT_CREATE_ACTION = 'CREATE';
const PRODUCT_UPDATE_ACTION = 'UPDATE';
/**
 * Prefix for the dynamically-registered per-product LOAN approval chain —
 * `LOAN/APPROVE_<productId>`. See registerLoanApprovalChain and
 * PHASE_7_NOTES.md; this is the main integration point Phase 8 depends on.
 */
export const LOAN_APPROVAL_ACTION_PREFIX = 'APPROVE_';

export function loanApprovalActionFor(productId: string): string {
  return `${LOAN_APPROVAL_ACTION_PREFIX}${productId}`;
}

interface ApprovalChainStepLike {
  order: number;
  requiredCapability: string;
}

interface LoanProductCreationPayload {
  name: string;
  interestRate: number;
  interestType: InterestType;
  tenureOptions: number[];
  minGroupSize: number;
  feeIds: string[];
  approvalChainSteps: ApprovalChainStepLike[];
  penaltyRule: PenaltyRule;
}

interface LoanProductUpdateChanges {
  name?: string;
  interestRate?: number;
  interestType?: InterestType;
  tenureOptions?: number[];
  minGroupSize?: number;
  feeIds?: string[];
  approvalChainSteps?: ApprovalChainStepLike[];
  penaltyRule?: PenaltyRule;
  status?: ProductStatus;
}

interface LoanProductUpdatePayload {
  productId: string;
  changes: LoanProductUpdateChanges;
}

@Injectable()
export class LoanProductsService implements OnModuleInit {
  constructor(
    @InjectModel(LoanProduct.name) private readonly loanProductModel: Model<LoanProductDocument>,
    private readonly workflowEngineService: WorkflowEngineService,
    private readonly feeDefinitionsService: FeeDefinitionsService,
    private readonly auditService: AuditService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Single step, same reasoning as FeeDefinitionsService — see that
    // service's onModuleInit comment and PHASE_7_NOTES.md.
    const steps = [
      { order: 0, requiredCapability: approveCapability(WorkflowEntityType.LOAN_PRODUCT) },
    ];
    await this.workflowEngineService.registerChainConfig({
      entityType: WorkflowEntityType.LOAN_PRODUCT,
      action: PRODUCT_CREATE_ACTION,
      restartOnReturn: true,
      steps,
    });
    await this.workflowEngineService.registerChainConfig({
      entityType: WorkflowEntityType.LOAN_PRODUCT,
      action: PRODUCT_UPDATE_ACTION,
      restartOnReturn: true,
      steps,
    });
  }

  // ---------------------------------------------------------------------------
  // Validation shared by create/update
  // ---------------------------------------------------------------------------

  private validateApprovalChainSteps(steps: ApprovalChainStepLike[]): void {
    if (steps.length === 0) {
      throw new BadRequestException('approvalChainSteps must not be empty');
    }
    const orders = [...steps].map((s) => s.order).sort((a, b) => a - b);
    const expected = orders.map((_, i) => i);
    const isContiguousFromZero = orders.every((order, i) => order === expected[i]);
    if (!isContiguousFromZero) {
      throw new BadRequestException(
        'approvalChainSteps must have contiguous zero-based order values (0, 1, 2, ...)',
      );
    }
    for (const step of steps) {
      // A typo'd capability here would silently make a step unfulfillable
      // by anyone — validate against the canonical known-capability
      // vocabulary rather than accepting an arbitrary string.
      if (!ALL_KNOWN_CAPABILITIES.includes(step.requiredCapability)) {
        throw new BadRequestException(
          `approvalChainSteps references an unknown capability: "${step.requiredCapability}"`,
        );
      }
    }
  }

  private resolvePenaltyRule(dto: PenaltyRuleDto): PenaltyRule {
    if (dto.calcType === FeeCalcType.PERCENTAGE && !dto.percentageOf) {
      throw new BadRequestException(
        'penaltyRule.percentageOf is required when penaltyRule.calcType is PERCENTAGE',
      );
    }
    return {
      calcType: dto.calcType,
      value: dto.value,
      percentageOf:
        dto.calcType === FeeCalcType.PERCENTAGE
          ? (dto.percentageOf as PenaltyPercentageBasis)
          : null,
      gracePeriodDays: dto.gracePeriodDays,
    };
  }

  // ---------------------------------------------------------------------------
  // Creation
  // ---------------------------------------------------------------------------

  async initiateCreation(
    dto: CreateLoanProductDto,
    initiatedBy: string,
  ): Promise<WorkflowRequestDocument> {
    // Redundant with the DTO's @Min(3), same "service must not trust a
    // caller that bypasses the DTO layer" reasoning as GroupsService.
    if (dto.minGroupSize < 3) {
      throw new BadRequestException('minGroupSize must be at least 3');
    }
    this.validateApprovalChainSteps(dto.approvalChainSteps);
    const penaltyRule = this.resolvePenaltyRule(dto.penaltyRule);

    if (dto.feeIds.length > 0) {
      await this.feeDefinitionsService.assertFeesExistAndActive(dto.feeIds);
    }

    const payload: LoanProductCreationPayload = {
      name: dto.name,
      interestRate: dto.interestRate,
      interestType: dto.interestType,
      tenureOptions: dto.tenureOptions,
      minGroupSize: dto.minGroupSize,
      feeIds: dto.feeIds,
      approvalChainSteps: dto.approvalChainSteps.map((s) => ({
        order: s.order,
        requiredCapability: s.requiredCapability,
      })),
      penaltyRule,
    };

    return this.workflowEngineService.initiate({
      entityType: WorkflowEntityType.LOAN_PRODUCT,
      action: PRODUCT_CREATE_ACTION,
      payload: payload as unknown as Record<string, unknown>,
      initiatedBy,
    });
  }

  private async onCreationApproved(event: WorkflowApprovedEvent): Promise<void> {
    const payload = event.payload as unknown as LoanProductCreationPayload;

    const created = await this.loanProductModel.create({
      name: payload.name,
      interestRate: payload.interestRate,
      interestType: payload.interestType,
      tenureOptions: payload.tenureOptions,
      minGroupSize: payload.minGroupSize,
      feeIds: payload.feeIds.map((id) => new Types.ObjectId(id)),
      approvalChainSteps: payload.approvalChainSteps,
      penaltyRule: payload.penaltyRule,
      status: ProductStatus.ACTIVE,
      createdBy: new Types.ObjectId(event.initiatedBy),
    });

    await this.registerLoanApprovalChain(created);

    await this.workflowEngineService.linkEntity(event.workflowRequestId, created._id.toString());

    await this.auditService.record({
      actorId: event.initiatedBy,
      action: 'LOAN_PRODUCT_CREATED',
      entityType: 'LOAN_PRODUCT',
      entityId: created._id.toString(),
      after: { name: payload.name, interestRate: payload.interestRate },
      metadata: { workflowRequestId: event.workflowRequestId },
    });
  }

  // ---------------------------------------------------------------------------
  // Update
  // ---------------------------------------------------------------------------

  async initiateUpdate(
    productId: string,
    dto: UpdateLoanProductDto,
    initiatedBy: string,
  ): Promise<WorkflowRequestDocument> {
    await this.findByIdOrThrow(productId);

    if (dto.minGroupSize !== undefined && dto.minGroupSize < 3) {
      throw new BadRequestException('minGroupSize must be at least 3');
    }
    if (dto.approvalChainSteps !== undefined) {
      this.validateApprovalChainSteps(dto.approvalChainSteps);
    }
    if (dto.feeIds !== undefined && dto.feeIds.length > 0) {
      await this.feeDefinitionsService.assertFeesExistAndActive(dto.feeIds);
    }

    // penaltyRule/approvalChainSteps excluded from the initial spread —
    // their DTO shapes (PenaltyRuleDto / ApprovalChainStepDto[]) aren't
    // structurally identical to the schema-facing types below, so they're
    // always explicitly re-derived instead.
    const {
      penaltyRule: _penaltyRuleDto,
      approvalChainSteps: _approvalChainStepsDto,
      ...rest
    } = dto;
    const changes: LoanProductUpdateChanges = { ...rest };
    if (dto.penaltyRule !== undefined) {
      changes.penaltyRule = this.resolvePenaltyRule(dto.penaltyRule);
    }
    if (dto.approvalChainSteps !== undefined) {
      changes.approvalChainSteps = dto.approvalChainSteps.map((s) => ({
        order: s.order,
        requiredCapability: s.requiredCapability,
      }));
    }

    const payload: LoanProductUpdatePayload = { productId, changes };

    return this.workflowEngineService.initiate({
      entityType: WorkflowEntityType.LOAN_PRODUCT,
      action: PRODUCT_UPDATE_ACTION,
      payload: payload as unknown as Record<string, unknown>,
      initiatedBy,
    });
  }

  private async onUpdateApproved(event: WorkflowApprovedEvent): Promise<void> {
    const payload = event.payload as unknown as LoanProductUpdatePayload;

    const setFields: Record<string, unknown> = { ...payload.changes };
    if (payload.changes.feeIds) {
      setFields.feeIds = payload.changes.feeIds.map((id) => new Types.ObjectId(id));
    }

    const updated = await this.loanProductModel
      .findByIdAndUpdate(payload.productId, { $set: setFields }, { new: true })
      .exec();
    if (!updated) {
      throw new Error(
        `LoanProduct ${payload.productId} not found at LOAN_PRODUCT/UPDATE approval time`,
      );
    }

    // Always re-derive the LOAN/APPROVE_<productId> chain from the
    // product's CURRENT approvalChainSteps — whether or not this specific
    // update touched that field. Cheap (WorkflowEngineService.replaceChainConfig
    // is a single upsert) and avoids a conditional that could drift out of
    // sync with what's actually stored on the product. Any WorkflowRequest
    // already in flight under the OLD chain shape is unaffected — see
    // replaceChainConfig's own doc comment.
    await this.registerLoanApprovalChain(updated);

    await this.workflowEngineService.linkEntity(event.workflowRequestId, updated._id.toString());

    await this.auditService.record({
      actorId: event.initiatedBy,
      action: 'LOAN_PRODUCT_UPDATED',
      entityType: 'LOAN_PRODUCT',
      entityId: updated._id.toString(),
      after: payload.changes as unknown as Record<string, unknown>,
      metadata: { workflowRequestId: event.workflowRequestId },
    });
  }

  /**
   * The main integration point Phase 8 depends on: registers/replaces a
   * `LOAN` chain under action `APPROVE_<productId>`, built from this
   * product's current `approvalChainSteps`, so a loan application against
   * this product can be `WorkflowEngineService.initiate()`d under a chain
   * shaped exactly the way this product's admin configured it — without the
   * generic engine ever needing to know what a "LoanProduct" is.
   */
  private async registerLoanApprovalChain(product: LoanProductDocument): Promise<void> {
    await this.workflowEngineService.replaceChainConfig({
      entityType: WorkflowEntityType.LOAN,
      action: loanApprovalActionFor(product._id.toString()),
      restartOnReturn: true,
      steps: product.approvalChainSteps.map((s) => ({
        order: s.order,
        requiredCapability: s.requiredCapability,
      })),
    });
  }

  // ---------------------------------------------------------------------------
  // Workflow event dispatch
  // ---------------------------------------------------------------------------

  // No WORKFLOW_REJECTED_EVENT handler — same reasoning as
  // FeeDefinitionsService: nothing persists before approval either way.
  @OnEvent(WORKFLOW_APPROVED_EVENT)
  async handleWorkflowApproved(event: WorkflowApprovedEvent): Promise<void> {
    if ((event.entityType as WorkflowEntityType) !== WorkflowEntityType.LOAN_PRODUCT) {
      return;
    }
    if (event.action === PRODUCT_CREATE_ACTION) {
      await this.onCreationApproved(event);
    } else if (event.action === PRODUCT_UPDATE_ACTION) {
      await this.onUpdateApproved(event);
    }
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  async findByIdOrThrow(id: string): Promise<LoanProductDocument> {
    const doc = await this.loanProductModel.findById(id).exec();
    if (!doc) {
      throw new NotFoundException(`LoanProduct ${id} not found`);
    }
    return doc;
  }

  async findAll(filter: { status?: ProductStatus } = {}): Promise<LoanProductDocument[]> {
    return this.loanProductModel.find(filter).sort({ createdAt: -1 }).exec();
  }
}
