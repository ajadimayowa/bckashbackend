import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import {
  FeeAppliesTo,
  FeeCalcType,
  FeeCategory,
  FeePercentageBasis,
  FeeTiming,
  PenaltyFrequency,
} from '../../common/enums/loan-product.enums';
import { WorkflowEntityType } from '../../common/enums/workflow.enums';
import { AuditService } from '../../platform/audit/audit.service';
import { approveCapability } from '../../platform/rbac/constants/capabilities';
import {
  WORKFLOW_APPROVED_EVENT,
  WorkflowApprovedEvent,
} from '../../platform/workflow-engine/events/workflow-engine.events';
import { WorkflowRequestDocument } from '../../platform/workflow-engine/schemas/workflow-request.schema';
import { WorkflowEngineService } from '../../platform/workflow-engine/workflow-engine.service';
import { CreateFeeDefinitionDto } from './dto/create-fee-definition.dto';
import { UpdateFeeDefinitionDto } from './dto/update-fee-definition.dto';
import { FeeDefinition, FeeDefinitionDocument } from './schemas/fee-definition.schema';

const FEE_CREATE_ACTION = 'CREATE';
const FEE_UPDATE_ACTION = 'UPDATE';

interface FeeCreationPayload {
  name: string;
  category: FeeCategory;
  timing: FeeTiming;
  calcType: FeeCalcType;
  value: number;
  percentageOf: FeePercentageBasis | null;
  appliesTo: FeeAppliesTo;
  productIds: string[];
  frequency: PenaltyFrequency;
  recurrenceIntervalDays: number | null;
  maxRecurrences: number | null;
}

interface FeeUpdateChanges {
  name?: string;
  category?: FeeCategory;
  timing?: FeeTiming;
  calcType?: FeeCalcType;
  value?: number;
  percentageOf?: FeePercentageBasis | null;
  appliesTo?: FeeAppliesTo;
  productIds?: string[];
  active?: boolean;
  frequency?: PenaltyFrequency;
  recurrenceIntervalDays?: number | null;
  maxRecurrences?: number | null;
}

interface FeeUpdatePayload {
  feeDefinitionId: string;
  changes: FeeUpdateChanges;
}

@Injectable()
export class FeeDefinitionsService implements OnModuleInit {
  constructor(
    @InjectModel(FeeDefinition.name)
    private readonly feeDefinitionModel: Model<FeeDefinitionDocument>,
    private readonly workflowEngineService: WorkflowEngineService,
    private readonly auditService: AuditService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Single step (Admin proposes, a *different* Admin/SuperAdmin/Approver
    // confirms — the engine's own maker!=checker rule still applies even
    // though ADMIN holds every capability in this chain) — not the two-step
    // review->approve pattern used for Group/Customer. This matches Phase
    // 2's own documented design intent for "config entity types": see
    // default-role-capabilities.ts's comment ("ADMIN: ... initiates +
    // approves loan product/fee config changes"), written before this
    // phase existed. See PHASE_7_NOTES.md for the full reasoning and how
    // this differs from Phase 6's two-step correction for Group/Customer.
    const steps = [
      { order: 0, requiredCapability: approveCapability(WorkflowEntityType.FEE_DEFINITION) },
    ];
    await this.workflowEngineService.registerChainConfig({
      entityType: WorkflowEntityType.FEE_DEFINITION,
      action: FEE_CREATE_ACTION,
      restartOnReturn: true,
      steps,
    });
    await this.workflowEngineService.registerChainConfig({
      entityType: WorkflowEntityType.FEE_DEFINITION,
      action: FEE_UPDATE_ACTION,
      restartOnReturn: true,
      steps,
    });
  }

  /** PERCENTAGE requires percentageOf; FIXED ignores/normalizes it to null, even if supplied. */
  private resolvePercentageOf(
    calcType: FeeCalcType,
    percentageOf: FeePercentageBasis | null | undefined,
  ): FeePercentageBasis | null {
    if (calcType === FeeCalcType.PERCENTAGE) {
      if (!percentageOf) {
        throw new BadRequestException('percentageOf is required when calcType is PERCENTAGE');
      }
      return percentageOf;
    }
    return null;
  }

  /**
   * Added in Phase 9 (see PHASE_9_NOTES.md) — same normalize/validate shape
   * as resolvePercentageOf: RECURRING requires recurrenceIntervalDays;
   * ONE_TIME normalizes both recurrence fields to null even if supplied.
   * Only meaningful today for an EARLY_LIQUIDATION-category fee (see
   * `modules/repayments`), but validated uniformly for every category so a
   * malformed RECURRING config can never be saved regardless of category.
   */
  private resolveFrequencyFields(
    frequency: PenaltyFrequency | undefined,
    recurrenceIntervalDays: number | undefined,
    maxRecurrences: number | undefined,
  ): {
    frequency: PenaltyFrequency;
    recurrenceIntervalDays: number | null;
    maxRecurrences: number | null;
  } {
    const resolvedFrequency = frequency ?? PenaltyFrequency.ONE_TIME;
    if (resolvedFrequency === PenaltyFrequency.RECURRING) {
      if (!recurrenceIntervalDays) {
        throw new BadRequestException(
          'recurrenceIntervalDays is required when frequency is RECURRING',
        );
      }
      return {
        frequency: resolvedFrequency,
        recurrenceIntervalDays,
        maxRecurrences: maxRecurrences ?? null,
      };
    }
    return { frequency: resolvedFrequency, recurrenceIntervalDays: null, maxRecurrences: null };
  }

  // ---------------------------------------------------------------------------
  // Creation
  // ---------------------------------------------------------------------------

  async initiateCreation(
    dto: CreateFeeDefinitionDto,
    initiatedBy: string,
  ): Promise<WorkflowRequestDocument> {
    const percentageOf = this.resolvePercentageOf(dto.calcType, dto.percentageOf);
    const frequencyFields = this.resolveFrequencyFields(
      dto.frequency,
      dto.recurrenceIntervalDays,
      dto.maxRecurrences,
    );

    const payload: FeeCreationPayload = {
      name: dto.name,
      category: dto.category,
      timing: dto.timing,
      calcType: dto.calcType,
      value: dto.value,
      percentageOf,
      appliesTo: dto.appliesTo,
      productIds: dto.productIds ?? [],
      ...frequencyFields,
    };

    return this.workflowEngineService.initiate({
      entityType: WorkflowEntityType.FEE_DEFINITION,
      action: FEE_CREATE_ACTION,
      payload: payload as unknown as Record<string, unknown>,
      initiatedBy,
    });
  }

  private async onCreationApproved(event: WorkflowApprovedEvent): Promise<void> {
    const payload = event.payload as unknown as FeeCreationPayload;

    const created = await this.feeDefinitionModel.create({
      name: payload.name,
      category: payload.category,
      timing: payload.timing,
      calcType: payload.calcType,
      value: payload.value,
      percentageOf: payload.percentageOf,
      appliesTo: payload.appliesTo,
      productIds: payload.productIds.map((id) => new Types.ObjectId(id)),
      active: true,
      createdBy: new Types.ObjectId(event.initiatedBy),
      frequency: payload.frequency,
      recurrenceIntervalDays: payload.recurrenceIntervalDays,
      maxRecurrences: payload.maxRecurrences,
    });

    await this.workflowEngineService.linkEntity(event.workflowRequestId, created._id.toString());

    await this.auditService.record({
      actorId: event.initiatedBy,
      action: 'FEE_DEFINITION_CREATED',
      entityType: 'FEE_DEFINITION',
      entityId: created._id.toString(),
      after: { name: payload.name, category: payload.category, value: payload.value },
      metadata: { workflowRequestId: event.workflowRequestId },
    });
  }

  // ---------------------------------------------------------------------------
  // Update
  // ---------------------------------------------------------------------------

  async initiateUpdate(
    feeDefinitionId: string,
    dto: UpdateFeeDefinitionDto,
    initiatedBy: string,
  ): Promise<WorkflowRequestDocument> {
    const existing = await this.findByIdOrThrow(feeDefinitionId);

    const changes: FeeUpdateChanges = { ...dto };

    // Only touch percentageOf if this update actually changes calcType or
    // percentageOf — an update to, say, just `name` shouldn't re-validate
    // or clobber percentageOf at all.
    if (dto.calcType !== undefined || dto.percentageOf !== undefined) {
      const effectiveCalcType = dto.calcType ?? existing.calcType;
      changes.percentageOf = this.resolvePercentageOf(
        effectiveCalcType,
        dto.percentageOf ?? existing.percentageOf ?? undefined,
      );
    }

    // Same isolation principle for the frequency fields — only re-validate
    // if this update actually touches one of them.
    if (
      dto.frequency !== undefined ||
      dto.recurrenceIntervalDays !== undefined ||
      dto.maxRecurrences !== undefined
    ) {
      const frequencyFields = this.resolveFrequencyFields(
        dto.frequency ?? existing.frequency,
        dto.recurrenceIntervalDays ?? existing.recurrenceIntervalDays ?? undefined,
        dto.maxRecurrences ?? existing.maxRecurrences ?? undefined,
      );
      changes.frequency = frequencyFields.frequency;
      changes.recurrenceIntervalDays = frequencyFields.recurrenceIntervalDays;
      changes.maxRecurrences = frequencyFields.maxRecurrences;
    }

    const payload: FeeUpdatePayload = { feeDefinitionId, changes };

    return this.workflowEngineService.initiate({
      entityType: WorkflowEntityType.FEE_DEFINITION,
      action: FEE_UPDATE_ACTION,
      payload: payload as unknown as Record<string, unknown>,
      initiatedBy,
    });
  }

  private async onUpdateApproved(event: WorkflowApprovedEvent): Promise<void> {
    const payload = event.payload as unknown as FeeUpdatePayload;

    const setFields: Record<string, unknown> = { ...payload.changes };
    if (payload.changes.productIds) {
      setFields.productIds = payload.changes.productIds.map((id) => new Types.ObjectId(id));
    }

    const updated = await this.feeDefinitionModel
      .findByIdAndUpdate(payload.feeDefinitionId, { $set: setFields }, { new: true })
      .exec();
    if (!updated) {
      throw new Error(
        `FeeDefinition ${payload.feeDefinitionId} not found at FEE_DEFINITION/UPDATE approval time`,
      );
    }

    await this.workflowEngineService.linkEntity(event.workflowRequestId, updated._id.toString());

    await this.auditService.record({
      actorId: event.initiatedBy,
      action: 'FEE_DEFINITION_UPDATED',
      entityType: 'FEE_DEFINITION',
      entityId: updated._id.toString(),
      after: payload.changes as unknown as Record<string, unknown>,
      metadata: { workflowRequestId: event.workflowRequestId },
    });
  }

  // ---------------------------------------------------------------------------
  // Workflow event dispatch
  // ---------------------------------------------------------------------------

  // No WORKFLOW_REJECTED_EVENT handler — creation never persists anything
  // before approval, and an update's proposed changes live only in the
  // WorkflowRequest payload, so there's nothing to clean up either way.
  @OnEvent(WORKFLOW_APPROVED_EVENT)
  async handleWorkflowApproved(event: WorkflowApprovedEvent): Promise<void> {
    if ((event.entityType as WorkflowEntityType) !== WorkflowEntityType.FEE_DEFINITION) {
      return;
    }
    if (event.action === FEE_CREATE_ACTION) {
      await this.onCreationApproved(event);
    } else if (event.action === FEE_UPDATE_ACTION) {
      await this.onUpdateApproved(event);
    }
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  async findByIdOrThrow(id: string): Promise<FeeDefinitionDocument> {
    const doc = await this.feeDefinitionModel.findById(id).exec();
    if (!doc) {
      throw new NotFoundException(`FeeDefinition ${id} not found`);
    }
    return doc;
  }

  async findAll(
    filter: { category?: FeeCategory; active?: boolean } = {},
  ): Promise<FeeDefinitionDocument[]> {
    return this.feeDefinitionModel.find(filter).sort({ createdAt: -1 }).exec();
  }

  /**
   * Used by LoanProductsService to validate `LoanProduct.feeIds` — every id
   * must reference an existing, active FeeDefinition. Throws if not.
   */
  async assertFeesExistAndActive(feeIds: string[]): Promise<void> {
    if (feeIds.length === 0) {
      return;
    }
    const uniqueIds = new Set(feeIds);
    const count = await this.feeDefinitionModel.countDocuments({
      _id: { $in: [...uniqueIds].map((id) => new Types.ObjectId(id)) },
      active: true,
    });
    if (count !== uniqueIds.size) {
      throw new BadRequestException(
        'One or more feeIds do not exist or are not an active FeeDefinition',
      );
    }
  }
}
