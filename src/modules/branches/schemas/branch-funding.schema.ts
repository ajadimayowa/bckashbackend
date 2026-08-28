import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';

import { BranchFundingSource, BranchFundingStatus } from '../../../common/enums/branch.enums';

export type BranchFundingDocument = HydratedDocument<BranchFunding>;

/**
 * Same embedded-subdocument shape as RepaymentRecord's own `DisputeDetails`
 * (see modules/repayments/schemas/repayment-record.schema.ts) — one dispute
 * "slot" per funding record; a new one can only be raised once the previous
 * is resolved (see BranchFundingService.raiseDispute). Deliberately doesn't
 * touch `BranchFunding.status`/the branch's fund balance itself — purely a
 * discussion + evidence trail; any balance correction a resolved dispute
 * implies is a manual follow-up outside this record, same as any other
 * accounting correction.
 */
@Schema({ _id: false })
export class BranchFundingDisputeDetails {
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Staff', required: true })
  raisedBy!: Types.ObjectId;

  @Prop({ type: String, required: true })
  reason!: string;

  /** Required — a dispute can't be raised without attaching document evidence (S3 key). See BranchFundingService.raiseDispute. */
  @Prop({ type: String, required: true })
  evidenceImageKey!: string;

  @Prop({ type: Date, required: true })
  raisedAt!: Date;

  @Prop({ type: String, enum: ['RESOLVED', 'DISMISSED'], default: null })
  resolution!: 'RESOLVED' | 'DISMISSED' | null;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Staff', default: null })
  resolvedBy!: Types.ObjectId | null;

  @Prop({ type: Date, default: null })
  resolvedAt!: Date | null;

  @Prop({ type: String, default: null })
  resolutionNote!: string | null;
}

export const BranchFundingDisputeDetailsSchema = SchemaFactory.createForClass(BranchFundingDisputeDetails);

/**
 * A two-party confirmation (head office records it, the branch's current
 * manager verifies or rejects it) — deliberately not routed through the
 * generic workflow engine. See PHASE_4_NOTES.md.
 */
@Schema({ timestamps: true, collection: 'branch_fundings' })
export class BranchFunding {
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Branch', required: true })
  branchId!: Types.ObjectId;

  /**
   * The branch's own bank account this funding is destined for — must be
   * `active` and belong to `branchId` at record time (see
   * BranchFundingService.recordFunding). A branch must have exactly one
   * active account before it can be funded at all.
   */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'BranchBankAccount', required: true })
  bankAccountId!: Types.ObjectId;

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

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Staff', required: true })
  recordedBy!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Staff', default: null })
  verifiedBy!: Types.ObjectId | null;

  @Prop({ type: Date, default: null })
  verifiedAt!: Date | null;

  @Prop({ type: String, default: null })
  rejectionReason!: string | null;

  @Prop({ type: BranchFundingDisputeDetailsSchema, default: null })
  disputeDetails!: BranchFundingDisputeDetails | null;

  /** Last time a "please confirm this" nudge email was sent to the branch's current manager — see BranchFundingService.nudgeManager. */
  @Prop({ type: Date, default: null })
  lastNudgedAt!: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const BranchFundingSchema = SchemaFactory.createForClass(BranchFunding);

BranchFundingSchema.index({ branchId: 1, status: 1, createdAt: -1 });
