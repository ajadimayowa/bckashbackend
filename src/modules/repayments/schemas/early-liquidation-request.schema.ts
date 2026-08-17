import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

import { EarlyLiquidationStatus } from '../../../common/enums/repayment.enums';

export type EarlyLiquidationRequestDocument = HydratedDocument<EarlyLiquidationRequest>;

/**
 * Workflow-mediated (single-step approval — see `EarlyLiquidationService`,
 * PHASE_9_NOTES.md), created immediately at request time (same immediate-
 * creation pattern as RepaymentRecord/Loan) so `outstandingBalanceAtRequestKobo`/
 * `liquidationFeeKobo` are locked in as a snapshot, never recomputed against
 * a later, different balance.
 *
 * `totalPayableKobo` starts as `outstandingBalanceAtRequestKobo + liquidationFeeKobo`
 * but is NOT immutable after that — a RECURRING early-liquidation fee accrues
 * further delay charges onto it for every period the request stays APPROVED
 * but unsettled (see `LiquidationDelayCharge`/`PenaltySweepService`). This is
 * a separate settlement track from `MemberLoanAccount.outstandingBalanceKobo`
 * until the linked repayment completes it — see `linkedRepaymentRecordId`.
 */
@Schema({ timestamps: true, collection: 'early_liquidation_requests' })
export class EarlyLiquidationRequest {
  @Prop({ type: Types.ObjectId, ref: 'MemberLoanAccount', required: true })
  memberLoanAccountId!: Types.ObjectId;

  @Prop({ type: Number, required: true })
  outstandingBalanceAtRequestKobo!: number;

  @Prop({ type: Number, required: true })
  liquidationFeeKobo!: number;

  @Prop({ type: Number, required: true })
  totalPayableKobo!: number;

  @Prop({
    type: String,
    enum: EarlyLiquidationStatus,
    required: true,
    default: EarlyLiquidationStatus.PENDING_APPROVAL,
  })
  status!: EarlyLiquidationStatus;

  @Prop({ type: Types.ObjectId, ref: 'Staff', required: true })
  requestedBy!: Types.ObjectId;

  @Prop({ type: Date, required: true })
  requestedAt!: Date;

  /** Set on workflow approval — the day-zero anchor for recurring delay-charge period calculations. */
  @Prop({ type: Date, default: null })
  approvedAt!: Date | null;

  @Prop({ type: Types.ObjectId, ref: 'RepaymentRecord', default: null })
  linkedRepaymentRecordId!: Types.ObjectId | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const EarlyLiquidationRequestSchema = SchemaFactory.createForClass(EarlyLiquidationRequest);

EarlyLiquidationRequestSchema.index({ memberLoanAccountId: 1, status: 1 });
