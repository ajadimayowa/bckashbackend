import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

import { BranchRequestStatus } from '../../../common/enums/branch.enums';

export type BranchRequestDocument = HydratedDocument<BranchRequest>;

/**
 * A branch manager's free-form request to head office — "make a request to
 * the head office" from the Manager's own Branch Management tab. Same
 * "two-party confirmation, not routed through the generic workflow engine"
 * shape as BranchFunding (raised by one party, resolved by another) — there's
 * no maker-checker approval chain here, just an open/resolved lifecycle.
 */
@Schema({ timestamps: true, collection: 'branch_requests' })
export class BranchRequest {
  @Prop({ type: Types.ObjectId, ref: 'Branch', required: true })
  branchId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Staff', required: true })
  raisedBy!: Types.ObjectId;

  @Prop({ type: String, required: true })
  subject!: string;

  @Prop({ type: String, required: true })
  message!: string;

  @Prop({ type: String, enum: BranchRequestStatus, required: true, default: BranchRequestStatus.OPEN })
  status!: BranchRequestStatus;

  @Prop({ type: Types.ObjectId, ref: 'Staff', default: null })
  resolvedBy!: Types.ObjectId | null;

  @Prop({ type: Date, default: null })
  resolvedAt!: Date | null;

  @Prop({ type: String, default: null })
  resolutionNote!: string | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const BranchRequestSchema = SchemaFactory.createForClass(BranchRequest);

BranchRequestSchema.index({ branchId: 1, status: 1, createdAt: -1 });
