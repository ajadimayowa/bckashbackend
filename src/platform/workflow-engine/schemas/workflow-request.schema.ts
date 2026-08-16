import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import { WorkflowStatus, WorkflowStepAction } from '../../../common/enums/workflow.enums';

export type WorkflowRequestDocument = HydratedDocument<WorkflowRequest>;

/**
 * Snapshot of one chain step's outcome, taken at request-creation time from the
 * matching WorkflowChainConfig and filled in as actors act on it. `actedBy` etc.
 * stay unset until someone acts on this specific step.
 */
@Schema({ _id: false })
export class WorkflowStepRecord {
  @Prop({ type: Number, required: true })
  order!: number;

  @Prop({ type: String, required: true })
  requiredCapability!: string;

  @Prop({ type: String, default: null })
  actedBy!: string | null;

  @Prop({ type: String, enum: WorkflowStepAction, default: null })
  action!: WorkflowStepAction | null;

  @Prop({ type: String, default: null })
  comment!: string | null;

  @Prop({ type: Date, default: null })
  actedAt!: Date | null;
}

export const WorkflowStepRecordSchema = SchemaFactory.createForClass(WorkflowStepRecord);

/** One submitted version of the payload — index 0 is the original submission. */
@Schema({ _id: false })
export class PayloadVersion {
  @Prop({ type: Object, required: true })
  payload!: Record<string, unknown>;

  @Prop({ type: String, required: true })
  submittedBy!: string;

  @Prop({ type: Date, required: true })
  submittedAt!: Date;
}

export const PayloadVersionSchema = SchemaFactory.createForClass(PayloadVersion);

/**
 * The generic maker-checker request. Domain modules never mutate this directly
 * — all transitions go through WorkflowEngineService. The underlying domain
 * entity is only created/mutated once this reaches APPROVED (see `workflow.approved`
 * event) — until then, proposed data lives entirely in `payloadHistory`.
 */
@Schema({ timestamps: true, collection: 'workflow_requests' })
export class WorkflowRequest {
  @Prop({ type: String, required: true })
  entityType!: string;

  /** null while this request is itself creating a new entity — see `linkEntity`. */
  @Prop({ type: String, default: null })
  entityId!: string | null;

  @Prop({ type: String, required: true })
  action!: string;

  @Prop({ type: String, enum: WorkflowStatus, required: true })
  status!: WorkflowStatus;

  /** `${entityType}:${action}` — which WorkflowChainConfig this instance is running. */
  @Prop({ type: String, required: true })
  chainConfigRef!: string;

  @Prop({ type: [WorkflowStepRecordSchema], required: true })
  steps!: WorkflowStepRecord[];

  @Prop({ type: Number, required: true, default: 0 })
  currentStepIndex!: number;

  @Prop({ type: [PayloadVersionSchema], required: true })
  payloadHistory!: PayloadVersion[];

  @Prop({ type: String, required: true })
  initiatedBy!: string;

  @Prop({ type: String, default: null })
  branchId!: string | null;
}

export const WorkflowRequestSchema = SchemaFactory.createForClass(WorkflowRequest);

WorkflowRequestSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });
WorkflowRequestSchema.index({ initiatedBy: 1, createdAt: -1 });
// Supports getPendingForActor: filter by status, then by the current step's
// requiredCapability without a full collection scan.
WorkflowRequestSchema.index({ status: 1, 'steps.order': 1 });
