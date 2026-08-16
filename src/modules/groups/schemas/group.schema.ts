import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

import { GroupStatus } from '../../../common/enums/group.enums';

export type GroupDocument = HydratedDocument<Group>;

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

  createdAt!: Date;
  updatedAt!: Date;
}

export const GroupSchema = SchemaFactory.createForClass(Group);

GroupSchema.index({ branchId: 1, status: 1 });
