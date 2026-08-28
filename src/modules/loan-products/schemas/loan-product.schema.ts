import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

import {
  FeeCalcType,
  InterestType,
  PenaltyFrequency,
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

  /** Required iff calcType === PERCENTAGE. See PenaltyPercentageBasis's own doc comment re: PRINCIPAL (added in Phase 9). */
  @Prop({ type: String, enum: PenaltyPercentageBasis, default: null })
  percentageOf!: PenaltyPercentageBasis | null;

  @Prop({ type: Number, required: true })
  gracePeriodDays!: number;

  /**
   * Added in Phase 9 (see PHASE_9_NOTES.md) — Phase 7 only ever built
   * ONE_TIME behavior with no field to express it. Defaults to ONE_TIME so
   * every LoanProduct created before this phase (schema-wise; none were ever
   * actually deployed) behaves unchanged.
   */
  @Prop({
    type: String,
    enum: PenaltyFrequency,
    required: true,
    default: PenaltyFrequency.ONE_TIME,
  })
  frequency!: PenaltyFrequency;

  /** Required iff frequency === RECURRING; null/ignored for ONE_TIME. */
  @Prop({ type: Number, default: null })
  recurrenceIntervalDays!: number | null;

  /** Optional even when RECURRING — null means "no cap, charge indefinitely". */
  @Prop({ type: Number, default: null })
  maxRecurrences!: number | null;
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

  /** Days, e.g. [14, 30, 60] — 14 is the system-wide floor, enforced by LoanProductsService/CreateLoanProductDto. */
  @Prop({ type: [Number], required: true })
  tenureOptions!: number[];

  /**
   * ADDED (weekly-repayment brief) — the number of calendar days one
   * repayment installment covers. Defaults to 7 (weekly), the coop's
   * standard cadence: interest/principal are spread evenly across
   * `ceil(tenureDays / repaymentPeriodDays)` installments instead of one per
   * calendar day, and each installment's due date is
   * `repaymentPeriodDays` days after the previous one (the first one that
   * many days after disbursement/cheque-pickup) — see
   * `LoanVerificationService.disburse`/`normalizeSchedule`. Defaulted rather
   * than backfilled per-product because nothing was ever actually deployed
   * with the old one-installment-per-day behavior (see PHASE_7/8 notes'
   * repeated "none were ever actually deployed" caveat) — every product,
   * existing or new, gets the weekly cadence unless explicitly overridden.
   */
  @Prop({ type: Number, required: true, default: 7, min: 1 })
  repaymentPeriodDays!: number;

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
