import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

import { GroupMemberRole, LEADERSHIP_ROLES } from '../../../common/enums/group.enums';

export type GroupMembershipDocument = HydratedDocument<GroupMembership>;

/**
 * Append-mostly — removal sets `leftAt`/`removedBy`/`removalReason` rather
 * than deleting the row, same principle as BranchManagerAssignment (see
 * branches/schemas/branch-manager-assignment.schema.ts). `getActiveMembers`
 * (leftAt: null) is the only sanctioned way to read a group's current roster.
 */
@Schema({ timestamps: true, collection: 'group_memberships' })
export class GroupMembership {
  @Prop({ type: Types.ObjectId, ref: 'Group', required: true })
  groupId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Customer', required: true })
  customerId!: Types.ObjectId;

  @Prop({ type: String, enum: GroupMemberRole, required: true })
  role!: GroupMemberRole;

  @Prop({ type: Date, required: true })
  joinedAt!: Date;

  /** null while this is the customer's active membership in this group. */
  @Prop({ type: Date, default: null })
  leftAt!: Date | null;

  @Prop({ type: Types.ObjectId, ref: 'Staff', required: true })
  addedBy!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Staff', default: null })
  removedBy!: Types.ObjectId | null;

  @Prop({ type: String, default: null })
  removalReason!: string | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const GroupMembershipSchema = SchemaFactory.createForClass(GroupMembership);

// Exactly one active (leftAt: null) holder per leadership role per group.
// Built as three separate per-role partial indexes rather than one
// `role: { $in: [...] }` index — MongoDB's partialFilterExpression only
// supports equality/$exists/$gt(e)/$lt(e)/$type/top-level $and, not $in, so a
// single combined index isn't expressible. MEMBER intentionally has no such
// index — many active MEMBER rows per group are expected.
for (const leadershipRole of LEADERSHIP_ROLES) {
  GroupMembershipSchema.index(
    { groupId: 1, role: 1 },
    {
      unique: true,
      partialFilterExpression: { leftAt: null, role: leadershipRole },
      name: `unique_active_${leadershipRole.toLowerCase()}_per_group`,
    },
  );
}

// A customer can only hold one active membership in a given group at a time.
GroupMembershipSchema.index(
  { groupId: 1, customerId: 1, leftAt: 1 },
  { unique: true, partialFilterExpression: { leftAt: null } },
);

GroupMembershipSchema.index({ groupId: 1, leftAt: 1 });
