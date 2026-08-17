import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type PenaltyChargeDocument = HydratedDocument<PenaltyCharge>;

/**
 * One row per charge — ONE_TIME rules always use `periodIndex: 0` (so the
 * unique index below naturally allows at most one); RECURRING rules get a
 * fresh `periodIndex` each period. This single index is what makes
 * `PenaltySweepService` safe to re-run at any point: a charge for a given
 * (account, installment, period) is created at most once no matter how many
 * times, or how irregularly, the sweep executes. See PHASE_9_NOTES.md.
 */
@Schema({ timestamps: false, collection: 'penalty_charges' })
export class PenaltyCharge {
  @Prop({ type: Types.ObjectId, ref: 'MemberLoanAccount', required: true })
  memberLoanAccountId!: Types.ObjectId;

  @Prop({ type: Number, required: true })
  scheduleInstallmentNumber!: number;

  @Prop({ type: Number, required: true, default: 0 })
  periodIndex!: number;

  @Prop({ type: Number, required: true })
  overdueAmountKobo!: number;

  @Prop({ type: Number, required: true })
  daysLateAtApplication!: number;

  @Prop({ type: Number, required: true })
  penaltyAmountKobo!: number;

  @Prop({ type: Date, required: true, default: () => new Date() })
  appliedAt!: Date;
}

export const PenaltyChargeSchema = SchemaFactory.createForClass(PenaltyCharge);

PenaltyChargeSchema.index(
  { memberLoanAccountId: 1, scheduleInstallmentNumber: 1, periodIndex: 1 },
  { unique: true },
);
