import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type BranchManagerAssignmentDocument = HydratedDocument<BranchManagerAssignment>;

/**
 * Append-mostly history — `assignManager` closes the prior active row
 * (`endDate = now`) and inserts a new one rather than mutating branchId onto
 * some other record. `getCurrentManager` is the *only* sanctioned way to find
 * a branch's current manager — no other module should keep its own
 * denormalized `branchManagerId`, precisely so this table can never drift out
 * of sync with whoever else thinks they know who the manager is.
 */
@Schema({ timestamps: true, collection: 'branch_manager_assignments' })
export class BranchManagerAssignment {
  @Prop({ type: Types.ObjectId, ref: 'Branch', required: true })
  branchId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Staff', required: true })
  staffId!: Types.ObjectId;

  @Prop({ type: Date, required: true })
  startDate!: Date;

  /** null while this is the current/active assignment for the branch. */
  @Prop({ type: Date, default: null })
  endDate!: Date | null;

  @Prop({ type: Types.ObjectId, ref: 'Staff', required: true })
  assignedBy!: Types.ObjectId;
}

export const BranchManagerAssignmentSchema = SchemaFactory.createForClass(BranchManagerAssignment);

// Exactly one active (endDate: null) assignment per branch at a time.
BranchManagerAssignmentSchema.index(
  { branchId: 1, endDate: 1 },
  { unique: true, partialFilterExpression: { endDate: null } },
);
BranchManagerAssignmentSchema.index({ branchId: 1, startDate: -1 });
