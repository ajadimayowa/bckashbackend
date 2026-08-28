import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';

export type BranchManagerAssignmentDocument = HydratedDocument<BranchManagerAssignment>;

/**
 * Append-mostly history — a row is only ever created by
 * BranchManagerAssignmentService's WORKFLOW_APPROVED_EVENT handler (a
 * different Admin/SuperAdmin/Approver must approve the proposal that
 * `initiateAssignment` raises — see that service's own doc comment),
 * closing the prior active row (`endDate = now`) and inserting a new one
 * rather than mutating branchId onto some other record. `getCurrentManager`
 * is the *only* sanctioned way to find a branch's current manager — no
 * other module should keep its own denormalized `branchManagerId`,
 * precisely so this table can never drift out of sync with whoever else
 * thinks they know who the manager is.
 */
@Schema({ timestamps: true, collection: 'branch_manager_assignments' })
export class BranchManagerAssignment {
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Branch', required: true })
  branchId!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Staff', required: true })
  staffId!: Types.ObjectId;

  @Prop({ type: Date, required: true })
  startDate!: Date;

  /** null while this is the current/active assignment for the branch. */
  @Prop({ type: Date, default: null })
  endDate!: Date | null;

  /** Who proposed this assignment — WorkflowRequest.initiatedBy, copied here so this row is a complete, self-contained record without a join back to the (possibly long-since-decided) request. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Staff', required: true })
  assignedBy!: Types.ObjectId;

  /** Who approved it — the maker-checker rule guarantees this is never the same staff member as `assignedBy`. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Staff', required: true })
  approvedBy!: Types.ObjectId;

  /** Optional free-text note the proposer left (e.g. why this manager, or why the prior one is being replaced) — carried over from the WorkflowRequest's payload, not editable after the fact. */
  @Prop({ type: String, default: null, trim: true })
  comments!: string | null;
}

export const BranchManagerAssignmentSchema = SchemaFactory.createForClass(BranchManagerAssignment);

// Exactly one active (endDate: null) assignment per branch at a time.
BranchManagerAssignmentSchema.index(
  { branchId: 1, endDate: 1 },
  { unique: true, partialFilterExpression: { endDate: null } },
);
BranchManagerAssignmentSchema.index({ branchId: 1, startDate: -1 });
