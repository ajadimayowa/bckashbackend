import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

import { BranchFundingSource, BranchFundingStatus } from '../../../common/enums/branch.enums';

export type BranchFundingDocument = HydratedDocument<BranchFunding>;

/**
 * A two-party confirmation (head office records it, the branch's current
 * manager verifies or rejects it) — deliberately not routed through the
 * generic workflow engine. See PHASE_4_NOTES.md.
 */
@Schema({ timestamps: true, collection: 'branch_fundings' })
export class BranchFunding {
  @Prop({ type: Types.ObjectId, ref: 'Branch', required: true })
  branchId!: Types.ObjectId;

  /** Kobo — integer, enforced at the DTO layer (class-validator), never a float. */
  @Prop({ type: Number, required: true })
  amount!: number;

  @Prop({ type: Date, required: true })
  fundedAt!: Date;

  @Prop({ type: String, default: null })
  reference!: string | null;

  @Prop({
    type: String,
    enum: BranchFundingSource,
    required: true,
    default: BranchFundingSource.HEAD_OFFICE,
  })
  source!: BranchFundingSource;

  @Prop({
    type: String,
    enum: BranchFundingStatus,
    required: true,
    default: BranchFundingStatus.PENDING_VERIFICATION,
  })
  status!: BranchFundingStatus;

  @Prop({ type: Types.ObjectId, ref: 'Staff', required: true })
  recordedBy!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Staff', default: null })
  verifiedBy!: Types.ObjectId | null;

  @Prop({ type: Date, default: null })
  verifiedAt!: Date | null;

  @Prop({ type: String, default: null })
  rejectionReason!: string | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const BranchFundingSchema = SchemaFactory.createForClass(BranchFunding);

BranchFundingSchema.index({ branchId: 1, status: 1, createdAt: -1 });
