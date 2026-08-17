import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type LeaveBalanceDocument = HydratedDocument<LeaveBalance>;

/**
 * One row per (staffId, leaveTypeId, year) — `usedDays` is derived/cached
 * from approved applications, kept in sync via `LeaveBalanceService`'s
 * idempotent apply/reverse methods (never written directly by anything
 * else). See PHASE_12_NOTES.md for the "how a row comes to exist in the
 * first place" (created lazily, on first balance lookup or leave
 * application, defaulted from `LeaveType.defaultAnnualAllocationDays`).
 */
@Schema({ timestamps: true, collection: 'leave_balances' })
export class LeaveBalance {
  @Prop({ type: Types.ObjectId, ref: 'Staff', required: true })
  staffId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'LeaveType', required: true })
  leaveTypeId!: Types.ObjectId;

  @Prop({ type: Number, required: true })
  year!: number;

  @Prop({ type: Number, required: true, min: 0 })
  allocatedDays!: number;

  @Prop({ type: Number, required: true, min: 0, default: 0 })
  usedDays!: number;
}

export const LeaveBalanceSchema = SchemaFactory.createForClass(LeaveBalance);

LeaveBalanceSchema.index({ staffId: 1, leaveTypeId: 1, year: 1 }, { unique: true });
