import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type LeaveTypeDocument = HydratedDocument<LeaveType>;

/**
 * CRUD is Admin-gated, deliberately NOT workflow-mediated — same "structural
 * configuration, not a money movement or a per-case decision" reasoning as
 * chart-of-accounts (Phase 10) and org-structure CRUD (Phase 3). Flagged for
 * confirmation in PHASE_12_NOTES.md, same as those precedents.
 */
@Schema({ timestamps: true, collection: 'leave_types' })
export class LeaveType {
  @Prop({ type: String, required: true, unique: true, trim: true })
  name!: string;

  /** 0 for "Unpaid" — a staff member can still apply, just against zero allocation (see assumption §2, insufficient balance never blocks submission). */
  @Prop({ type: Number, required: true, min: 0 })
  defaultAnnualAllocationDays!: number;

  @Prop({ type: Boolean, required: true })
  paid!: boolean;

  @Prop({ type: Boolean, required: true, default: true })
  active!: boolean;
}

export const LeaveTypeSchema = SchemaFactory.createForClass(LeaveType);
