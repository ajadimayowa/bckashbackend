import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

import { ConfigRecordStatus, RepaymentFrequency } from '../../../common/enums/platform-config.enums';

export type RepaymentPenaltyConfigurationDocument = HydratedDocument<RepaymentPenaltyConfiguration>;

/** Versioned — see LoanConfiguration's own doc comment for the pattern this follows. */
@Schema({ timestamps: true, collection: 'repayment_penalty_configurations' })
export class RepaymentPenaltyConfiguration {
  /** Basis points (250 = 2.50%). */
  @Prop({ type: Number, required: true })
  penaltyRate!: number;

  @Prop({ type: Number, required: true })
  penaltyGracePeriodDays!: number;

  /** Basis points (2500 = 25.00%) — a cap on total accrued penalty, not a per-charge value. */
  @Prop({ type: Number, required: true })
  maxPenaltyCap!: number;

  @Prop({ type: Boolean, required: true, default: true })
  autoPenalty!: boolean;

  @Prop({ type: String, enum: RepaymentFrequency, required: true })
  repaymentFrequency!: RepaymentFrequency;

  @Prop({ type: String, enum: ConfigRecordStatus, required: true, default: ConfigRecordStatus.ACTIVE })
  status!: ConfigRecordStatus;

  @Prop({ type: Types.ObjectId, ref: 'Staff', required: true })
  proposedBy!: Types.ObjectId;

  @Prop({ type: Date, required: true })
  proposedAt!: Date;

  @Prop({ type: Types.ObjectId, ref: 'Staff', required: true })
  approvedBy!: Types.ObjectId;

  @Prop({ type: Date, required: true })
  approvedAt!: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export const RepaymentPenaltyConfigurationSchema = SchemaFactory.createForClass(RepaymentPenaltyConfiguration);

RepaymentPenaltyConfigurationSchema.index({ status: 1 });
