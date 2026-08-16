import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type WorkflowChainConfigDocument = HydratedDocument<WorkflowChainConfig>;

/**
 * One ordered step in a chain: which capability an actor must hold to act on a
 * WorkflowRequest sitting at this step. The engine never interprets
 * `requiredCapability` beyond string equality against the actor's capability
 * list — RBAC/domain modules own what these strings mean.
 */
@Schema({ _id: false })
export class WorkflowStepConfig {
  @Prop({ type: Number, required: true })
  order!: number;

  @Prop({ type: String, required: true })
  requiredCapability!: string;
}

export const WorkflowStepConfigSchema = SchemaFactory.createForClass(WorkflowStepConfig);

/**
 * Registered by each domain module at init time (`WorkflowEngineService.registerChainConfig`)
 * rather than hardcoded — stored so an Admin can inspect/edit chains later without
 * a redeploy. `entityType`/`action` are opaque strings to the engine; see
 * common/enums/workflow.enums.ts for the shared vocabulary domain modules use.
 *
 * `steps` must have length >= 1 with contiguous zero-based `order` (0, 1, 2, ...)
 * — enforced by WorkflowEngineService.registerChainConfig, not by the schema
 * itself, since Mongoose validators can't easily express "array is a contiguous
 * 0..N-1 sequence".
 */
@Schema({ timestamps: true, collection: 'workflow_chain_configs' })
export class WorkflowChainConfig {
  @Prop({ type: String, required: true })
  entityType!: string;

  @Prop({ type: String, required: true })
  action!: string;

  @Prop({ type: Boolean, required: true, default: true })
  restartOnReturn!: boolean;

  @Prop({ type: [WorkflowStepConfigSchema], required: true })
  steps!: WorkflowStepConfig[];

  @Prop({ type: Boolean, required: true, default: true })
  isActive!: boolean;
}

export const WorkflowChainConfigSchema = SchemaFactory.createForClass(WorkflowChainConfig);

WorkflowChainConfigSchema.index({ entityType: 1, action: 1 }, { unique: true });
