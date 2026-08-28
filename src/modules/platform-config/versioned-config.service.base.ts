import { OnModuleInit } from '@nestjs/common';
import { Document, Model, Types } from 'mongoose';

import { ConfigRecordStatus } from '../../common/enums/platform-config.enums';
import { WorkflowEntityType } from '../../common/enums/workflow.enums';
import { AuditService } from '../../platform/audit/audit.service';
import { approveCapability } from '../../platform/rbac/constants/capabilities';
import { WorkflowApprovedEvent } from '../../platform/workflow-engine/events/workflow-engine.events';
import { WorkflowRequestDocument } from '../../platform/workflow-engine/schemas/workflow-request.schema';
import { WorkflowEngineService } from '../../platform/workflow-engine/workflow-engine.service';

const CREATE_ACTION = 'CREATE';

interface VersionedConfigFields {
  status: ConfigRecordStatus;
  proposedBy: Types.ObjectId;
  proposedAt: Date;
  approvedBy: Types.ObjectId;
  approvedAt: Date;
}

/**
 * Shared plumbing for every Settings > "Loan Configuration" / "Repayment &
 * Penalties" / "Branch Rules" style entity: a *versioned* singleton — never
 * edited in place, every approved proposal becomes its own new record, and
 * whichever record was previously ACTIVE (if any) is flipped to INACTIVE in
 * the same operation, so "the latest active one is the active one" always
 * holds. Single-step chain (Admin/SuperAdmin proposes, a *different*
 * Admin/SuperAdmin/Approver approves) — identical shape to
 * LoanProductsService/FeeDefinitionsService, just generalized here since all
 * three of these entity types are otherwise near-identical boilerplate.
 *
 * Each concrete subclass still declares its own `@OnEvent(WORKFLOW_APPROVED_EVENT)`
 * handler that delegates to `handleApproved` here (rather than relying on
 * decorator metadata declared on this base class being picked up on a
 * subclass instance) — matches how every other domain module in this
 * codebase wires its own listener explicitly.
 */
export abstract class VersionedConfigServiceBase<
  TFields extends VersionedConfigFields,
  TDoc extends Document & TFields,
  TCreatePayload extends object,
> implements OnModuleInit
{
  protected abstract readonly entityType: WorkflowEntityType;
  /** Used for AuditLog.action, e.g. 'LOAN_CONFIG_CREATED'. */
  protected abstract readonly auditActionPrefix: string;

  constructor(
    protected readonly model: Model<TDoc>,
    protected readonly workflowEngineService: WorkflowEngineService,
    protected readonly auditService: AuditService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.workflowEngineService.registerChainConfig({
      entityType: this.entityType,
      action: CREATE_ACTION,
      restartOnReturn: true,
      steps: [{ order: 0, requiredCapability: approveCapability(this.entityType) }],
    });
  }

  /** Turns a validated create-DTO into the payload handed to the workflow engine. Identity by default — override if the DTO shape needs adjusting before it's stored on the WorkflowRequest. */
  protected buildProposalPayload(dto: TCreatePayload): TCreatePayload {
    return dto;
  }

  /** Maps the approved payload onto the fields this schema actually owns (everything except status/proposedBy/proposedAt/approvedBy/approvedAt, which this base class fills in). */
  protected abstract mapPayloadToDoc(payload: TCreatePayload): Record<string, unknown>;

  async initiateCreation(dto: TCreatePayload, initiatedBy: string): Promise<WorkflowRequestDocument> {
    return this.workflowEngineService.initiate({
      entityType: this.entityType,
      action: CREATE_ACTION,
      payload: this.buildProposalPayload(dto) as unknown as Record<string, unknown>,
      initiatedBy,
    });
  }

  /**
   * Deactivate whatever was ACTIVE (if anything) and insert the newly
   * approved version as ACTIVE — both in the same handler invocation, so
   * there's never a moment with zero or two ACTIVE records visible to a
   * concurrent reader (Mongo doesn't give us a cross-collection transaction
   * here, but these two writes are fast and sequential, same acceptable
   * window every other "flip status" flow in this codebase relies on).
   */
  protected async handleApproved(event: WorkflowApprovedEvent): Promise<void> {
    if ((event.entityType as WorkflowEntityType) !== this.entityType || event.action !== CREATE_ACTION) {
      return;
    }

    const payload = event.payload as unknown as TCreatePayload;
    const now = new Date();

    await this.model.updateMany({ status: ConfigRecordStatus.ACTIVE }, { $set: { status: ConfigRecordStatus.INACTIVE } }).exec();

    const created = await this.model.create({
      ...this.mapPayloadToDoc(payload),
      status: ConfigRecordStatus.ACTIVE,
      proposedBy: new Types.ObjectId(event.initiatedBy),
      proposedAt: now,
      approvedBy: new Types.ObjectId(event.approvedBy),
      approvedAt: now,
    });

    await this.workflowEngineService.linkEntity(event.workflowRequestId, created._id.toString());

    await this.auditService.record({
      actorId: event.approvedBy,
      action: `${this.auditActionPrefix}_CREATED`,
      entityType: this.entityType,
      entityId: created._id.toString(),
      after: this.mapPayloadToDoc(payload),
      metadata: { workflowRequestId: event.workflowRequestId, proposedBy: event.initiatedBy },
    });
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /** Every version, newest first — "fetched according to date created[/approved]" is just sorting/filtering this list client-side or via query params on the concrete controller. */
  async findAll(): Promise<TDoc[]> {
    return this.model.find().sort({ createdAt: -1 }).exec();
  }

  async findActive(): Promise<TDoc | null> {
    return this.model.findOne({ status: ConfigRecordStatus.ACTIVE }).exec();
  }

  async findById(id: string): Promise<TDoc | null> {
    return this.model.findById(id).exec();
  }
}
