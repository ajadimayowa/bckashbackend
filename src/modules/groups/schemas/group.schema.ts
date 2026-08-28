import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

import { GroupStatus } from '../../../common/enums/group.enums';

export type GroupDocument = HydratedDocument<Group>;

export enum GroupEditPrivilegeStatus {
  NONE = 'NONE',
  PENDING = 'PENDING',
  GRANTED = 'GRANTED',
  REJECTED = 'REJECTED',
}

/**
 * Once a Group is ACTIVE, `GroupsService.updateGroupDetails` refuses to
 * touch its free-text intake fields unless `status === GRANTED` — the
 * creator must first request permission (a reason), and only Admin/
 * SuperAdmin/Approver can grant it. Consumed (reset to NONE) the moment
 * it's actually used for an edit — same one-shot spirit as Customer's own
 * EditPrivilege (see customers/schemas/customer.schema.ts), minus the
 * signature requirement, which has no group-level equivalent.
 */
@Schema({ _id: false })
export class GroupEditPrivilege {
  @Prop({ type: String, enum: GroupEditPrivilegeStatus, required: true, default: GroupEditPrivilegeStatus.NONE })
  status!: GroupEditPrivilegeStatus;

  @Prop({ type: String, default: null })
  reason!: string | null;

  @Prop({ type: Types.ObjectId, ref: 'Staff', default: null })
  requestedBy!: Types.ObjectId | null;

  @Prop({ type: Date, default: null })
  requestedAt!: Date | null;

  @Prop({ type: Types.ObjectId, ref: 'Staff', default: null })
  decidedBy!: Types.ObjectId | null;

  @Prop({ type: Date, default: null })
  decidedAt!: Date | null;

  @Prop({ type: String, default: null })
  decisionComment!: string | null;
}

export const GroupEditPrivilegeSchema = SchemaFactory.createForClass(GroupEditPrivilege);

/**
 * Only ever created by `GroupsService.handleGroupCreationApproved` once a
 * GROUP/CREATE workflow request reaches APPROVED — no Group document exists
 * while the request is in flight, same pattern as Staff (see
 * identity/schemas/staff.schema.ts, PHASE_3_NOTES.md).
 */
@Schema({ timestamps: true, collection: 'groups' })
export class Group {
  @Prop({ type: String, required: true, trim: true })
  name!: string;

  @Prop({ type: Types.ObjectId, ref: 'Branch', required: true })
  branchId!: Types.ObjectId;

  @Prop({ type: String, enum: GroupStatus, required: true, default: GroupStatus.ACTIVE })
  status!: GroupStatus;

  @Prop({ type: Types.ObjectId, ref: 'Staff', required: true })
  createdBy!: Types.ObjectId;

  /**
   * Free-text intake fields from the onboarding wizard — all optional,
   * purely informational, never gated on. Deliberately NOT how the real
   * leadership role is assigned: `proposedLeaderName` is just a name the
   * marketer typed at intake, distinct from `GROUP_HEAD` on
   * GroupMembership, which is always derived from `proposedMemberCustomerIds`
   * order at approval time (see GroupsService.onGroupCreationApproved) — the
   * two can disagree (e.g. if the named leader isn't even index 0), and
   * that's fine; this field is a note, not a source of truth.
   */
  @Prop({ type: String, default: null, trim: true })
  proposedLeaderName!: string | null;

  @Prop({ type: String, default: null, trim: true })
  meetingDay!: string | null;

  @Prop({ type: String, default: null, trim: true })
  meetingLocation!: string | null;

  /** What the marketer expected at intake — not reconciled against the actual member count, which is always GroupMembership's own live count. */
  @Prop({ type: Number, default: null })
  expectedMemberCount!: number | null;

  /** Gate on editing an ACTIVE group's intake details — see GroupEditPrivilege's own doc comment. */
  @Prop({ type: GroupEditPrivilegeSchema, default: () => ({}) })
  editPrivilege!: GroupEditPrivilege;

  createdAt!: Date;
  updatedAt!: Date;
}

export const GroupSchema = SchemaFactory.createForClass(Group);

GroupSchema.index({ branchId: 1, status: 1 });
