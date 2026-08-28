import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';

import { StaffRole } from '../../../common/enums/identity.enums';

export type BranchStaffRoleAssignmentDocument = HydratedDocument<BranchStaffRoleAssignment>;

/** The two roles that can be assigned coverage of a branch this way — deliberately excludes MANAGER (that stays BranchManagerAssignment's single-active-per-branch model, see that schema's own doc comment) and MARKETER/SUPERADMIN (never branch-scoped). */
export type BranchStaffAssignmentRole = StaffRole.ADMIN | StaffRole.APPROVER;

export const BRANCH_STAFF_ASSIGNMENT_ROLES: readonly BranchStaffAssignmentRole[] = [
  StaffRole.ADMIN,
  StaffRole.APPROVER,
];

/**
 * Many-to-many analogue of BranchManagerAssignment (see that schema's own
 * doc comment for the shared append-only/history shape) — one ADMIN or
 * APPROVER can actively cover many branches at once, and one branch can have
 * many active ADMIN/APPROVER rows, unlike a branch's single active manager.
 * A row is only ever created by BranchStaffRoleAssignmentService's
 * WORKFLOW_APPROVED_EVENT handler (a different Admin/SuperAdmin/Approver
 * must approve the proposal `initiateAssignment` raises), and only ever
 * closed (`endDate` set) by `revokeAssignment` — a direct action, not
 * workflow-mediated (see that service's own doc comment). `getStaffForBranch`/
 * `getBranchesForStaff` are the sanctioned ways to resolve either direction
 * — no other module should keep its own denormalized copy of "who covers
 * this branch."
 */
@Schema({ timestamps: true, collection: 'branch_staff_role_assignments' })
export class BranchStaffRoleAssignment {
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Staff', required: true })
  staffId!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Branch', required: true })
  branchId!: Types.ObjectId;

  @Prop({ type: String, enum: BRANCH_STAFF_ASSIGNMENT_ROLES, required: true })
  role!: BranchStaffAssignmentRole;

  @Prop({ type: Date, required: true })
  startDate!: Date;

  /** null while this (staffId, branchId, role) coverage is active. */
  @Prop({ type: Date, default: null })
  endDate!: Date | null;

  /** Who proposed this assignment — WorkflowRequest.initiatedBy, copied here so this row is self-contained without a join back to the (possibly long-since-decided) request. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Staff', required: true })
  assignedBy!: Types.ObjectId;

  /** Who approved it — the maker-checker rule guarantees this is never the same staff member as `assignedBy`. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Staff', required: true })
  approvedBy!: Types.ObjectId;

  /** Optional free-text note the proposer left, carried over from the WorkflowRequest's payload — not editable after the fact. */
  @Prop({ type: String, default: null, trim: true })
  comments!: string | null;
}

export const BranchStaffRoleAssignmentSchema = SchemaFactory.createForClass(BranchStaffRoleAssignment);

// At most one active (endDate: null) row per (staff, branch, role) — the
// many-to-many analogue of BranchManagerAssignment's per-branch uniqueness,
// scoped narrower so many staff can cover one branch and one staff can cover
// many branches. Also makes WORKFLOW_APPROVED_EVENT's apply step safely
// idempotent: a batch that includes a branch the staff already actively
// covers upserts onto this same row instead of throwing/duplicating.
BranchStaffRoleAssignmentSchema.index(
  { staffId: 1, branchId: 1, role: 1, endDate: 1 },
  { unique: true, partialFilterExpression: { endDate: null } },
);
// Reverse lookup — "which branches does this staff member currently cover."
BranchStaffRoleAssignmentSchema.index({ staffId: 1, endDate: 1 });
// Forward lookup — "who currently covers this branch."
BranchStaffRoleAssignmentSchema.index({ branchId: 1, role: 1, endDate: 1 });
