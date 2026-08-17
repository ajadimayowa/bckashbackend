import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type LiquidationDelayChargeDocument = HydratedDocument<LiquidationDelayCharge>;

/** Same idempotency mechanism as PenaltyCharge, scoped to a liquidation request instead of an installment. See PHASE_9_NOTES.md. */
@Schema({ timestamps: false, collection: 'liquidation_delay_charges' })
export class LiquidationDelayCharge {
  @Prop({ type: Types.ObjectId, ref: 'EarlyLiquidationRequest', required: true })
  liquidationRequestId!: Types.ObjectId;

  @Prop({ type: Number, required: true })
  periodIndex!: number;

  @Prop({ type: Number, required: true })
  chargeAmountKobo!: number;

  @Prop({ type: Date, required: true, default: () => new Date() })
  appliedAt!: Date;
}

export const LiquidationDelayChargeSchema = SchemaFactory.createForClass(LiquidationDelayCharge);

LiquidationDelayChargeSchema.index({ liquidationRequestId: 1, periodIndex: 1 }, { unique: true });
