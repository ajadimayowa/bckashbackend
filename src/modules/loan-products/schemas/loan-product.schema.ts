import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

import {
  FeeCalcType,
  InterestType,
  PenaltyPercentageBasis,
  ProductStatus,
} from '../../../common/enums/loan-product.enums';
// Reused directly rather than re-declared — identical {order, requiredCapability}
// shape as the generic engine's own chain config subdocument. See
// LoanProductsService for how `approvalChainSteps` gets fed straight into
// `WorkflowEngineService.registerChainConfig` on approval.
import {
  WorkflowStepConfig,
  WorkflowStepConfigSchema,
} from '../../../platform/workflow-engine/schemas/workflow-chain-config.schema';

export type LoanProductDocument = HydratedDocument<LoanProduct>;

@Schema({ _id: false })
export class PenaltyRule {
  @Prop({ type: String, enum: FeeCalcType, required: true })
  calcType!: FeeCalcType;

  /** Kobo when calcType === FIXED; basis points when calcType === PERCENTAGE. */
  @Prop({ type: Number, required: true })
  value!: number;

  /** Required iff calcType === PERCENTAGE. Never PRINCIPAL — a loan already exists by the time a penalty applies. */
  @Prop({ type: String, enum: PenaltyPercentageBasis, default: null })
  percentageOf!: PenaltyPercentageBasis | null;

  @Prop({ type: Number, required: true })
  gracePeriodDays!: number;
}

export const PenaltyRuleSchema = SchemaFactory.createForClass(PenaltyRule);

/**
 * Only ever created by LoanProductsService's `workflow.approved` handler for
 * `LOAN_PRODUCT/CREATE` — same "doesn't exist until approved" pattern as
 * Group/Staff/FeeDefinition. Updates are workflow-mediated too
 * (`LOAN_PRODUCT/UPDATE`); on approval, beyond `$set`-ing the changed
 * fields, a fresh `LOAN/APPROVE_<productId>` chain config is (re)registered
 * from the product's current `approvalChainSteps` — see
 * LoanProductsService.onProductApproved and PHASE_7_NOTES.md for why this is
 * the main integration point Phase 8 depends on.
 */
@Schema({ timestamps: true, collection: 'loan_products' })
export class LoanProduct {
  @Prop({ type: String, required: true, trim: true })
  name!: string;

  /** Annual rate, basis points (1500 = 15.00%, never "15" flat). */
  @Prop({ type: Number, required: true })
  interestRate!: number;

  @Prop({ type: String, enum: InterestType, required: true })
  interestType!: InterestType;

  /** Months, e.g. [3, 6, 12]. */
  @Prop({ type: [Number], required: true })
  tenureOptions!: number[];

  /** Hard floor of 3 — the system-wide group minimum from Phase 6 — enforced by LoanProductsService. */
  @Prop({ type: Number, required: true })
  minGroupSize!: number;

  @Prop({ type: [Types.ObjectId], ref: 'FeeDefinition', default: [] })
  feeIds!: Types.ObjectId[];

  @Prop({ type: [WorkflowStepConfigSchema], required: true })
  approvalChainSteps!: WorkflowStepConfig[];

  @Prop({ type: PenaltyRuleSchema, required: true })
  penaltyRule!: PenaltyRule;

  @Prop({ type: String, enum: ProductStatus, required: true, default: ProductStatus.ACTIVE })
  status!: ProductStatus;

  @Prop({ type: Types.ObjectId, ref: 'Staff', required: true })
  createdBy!: Types.ObjectId;

  createdAt!: Date;
  updatedAt!: Date;
}

export const LoanProductSchema = SchemaFactory.createForClass(LoanProduct);

LoanProductSchema.index({ status: 1 });
