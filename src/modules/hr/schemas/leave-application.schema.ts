import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

import { LeaveApplicationStatus, LeaveChainAction } from '../../../common/enums/hr.enums';

export type LeaveApplicationDocument = HydratedDocument<LeaveApplication>;

/**
 * Created immediately at submission (status: PENDING_REVIEW) — same
 * "create now, workflow-gate the outcome" pattern as loans/repayments (see
 * PHASE_8_NOTES.md): HR/managers need a visible queue of pending requests
 * before any approval happens. `numberOfDays` is computed once at
 * submission (calendar-days-inclusive, assumption §1) and never
 * recomputed. `balanceApplied` is the idempotency guard for
 * `LeaveBalanceService`'s apply/reverse — same pattern as
 * `RepaymentRecord.appliedToBalance`.
 */
@Schema({ timestamps: true, collection: 'leave_applications' })
export class LeaveApplication {
  @Prop({ type: Types.ObjectId, ref: 'Staff', required: true })
  staffId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'LeaveType', required: true })
  leaveTypeId!: Types.ObjectId;

  @Prop({ type: Date, required: true })
  startDate!: Date;

  @Prop({ type: Date, required: true })
  endDate!: Date;

  @Prop({ type: Number, required: true })
  numberOfDays!: number;

  @Prop({ type: String, required: true })
  reason!: string;

  @Prop({ type: String, enum: LeaveApplicationStatus, required: true })
  status!: LeaveApplicationStatus;

  @Prop({ type: Date, required: true, default: () => new Date() })
  appliedAt!: Date;

  @Prop({ type: Boolean, required: true, default: false })
  balanceApplied!: boolean;

  /** Which of the three dynamically-selected chains this went through — see LeaveApplicationService.applyForLeave. */
  @Prop({ type: String, enum: LeaveChainAction, required: true })
  chainAction!: LeaveChainAction;

  /**
   * Snapshot, at submission time, of whether `numberOfDays` exceeded the
   * applicant's remaining balance — surfaced to the reviewer/approver per
   * assumption §2 (insufficient balance never blocks submission, it's
   * flagged instead). Recomputing this later could drift from what the
   * reviewer actually saw, so it's captured once, not derived on every read.
   */
  @Prop({ type: Boolean, required: true, default: false })
  balanceShortfallFlagged!: boolean;

  @Prop({ type: Number, default: null })
  balanceShortfallDays!: number | null;
}

export const LeaveApplicationSchema = SchemaFactory.createForClass(LeaveApplication);

LeaveApplicationSchema.index({ staffId: 1, appliedAt: -1 });
LeaveApplicationSchema.index({ status: 1, appliedAt: -1 });
