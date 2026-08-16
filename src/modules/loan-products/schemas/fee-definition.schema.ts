import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

import {
  FeeAppliesTo,
  FeeCalcType,
  FeeCategory,
  FeePercentageBasis,
  FeeTiming,
} from '../../../common/enums/loan-product.enums';

export type FeeDefinitionDocument = HydratedDocument<FeeDefinition>;

/**
 * Only ever created by FeeDefinitionsService's `workflow.approved` handler
 * for `FEE_DEFINITION/CREATE` — no document exists while the request is in
 * flight, same pattern as Group/Staff. Updates are also workflow-mediated
 * (`FEE_DEFINITION/UPDATE`) — the proposed field changes sit in the
 * WorkflowRequest payload until approved, then get `$set` onto the existing
 * document; nothing about an existing fee's *live* terms changes until then.
 */
@Schema({ timestamps: true, collection: 'fee_definitions' })
export class FeeDefinition {
  @Prop({ type: String, required: true, trim: true })
  name!: string;

  @Prop({ type: String, enum: FeeCategory, required: true })
  category!: FeeCategory;

  @Prop({ type: String, enum: FeeTiming, required: true })
  timing!: FeeTiming;

  @Prop({ type: String, enum: FeeCalcType, required: true })
  calcType!: FeeCalcType;

  /** Kobo when calcType === FIXED; basis points when calcType === PERCENTAGE. See loan-product.enums.ts. */
  @Prop({ type: Number, required: true })
  value!: number;

  /** Required iff calcType === PERCENTAGE; null/ignored for FIXED. Enforced by FeeDefinitionsService, not the schema. */
  @Prop({ type: String, enum: FeePercentageBasis, default: null })
  percentageOf!: FeePercentageBasis | null;

  @Prop({ type: String, enum: FeeAppliesTo, required: true })
  appliesTo!: FeeAppliesTo;

  /**
   * Admin-set at fee-creation/update time, not automatically kept in sync
   * with any LoanProduct — the authoritative direction is the other way
   * around (`LoanProduct.feeIds`, validated by LoanProductsService against
   * `FeeDefinitionsService.assertFeesExistAndActive`). This field is
   * informational/denormalized. See PHASE_7_NOTES.md.
   */
  @Prop({ type: [Types.ObjectId], ref: 'LoanProduct', default: [] })
  productIds!: Types.ObjectId[];

  @Prop({ type: Boolean, required: true, default: true })
  active!: boolean;

  @Prop({ type: Types.ObjectId, ref: 'Staff', required: true })
  createdBy!: Types.ObjectId;

  createdAt!: Date;
  updatedAt!: Date;
}

export const FeeDefinitionSchema = SchemaFactory.createForClass(FeeDefinition);

FeeDefinitionSchema.index({ category: 1, active: 1 });
