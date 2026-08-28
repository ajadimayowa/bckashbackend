import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

import { ConfigRecordStatus } from '../../../common/enums/platform-config.enums';

export type BranchRulesConfigurationDocument = HydratedDocument<BranchRulesConfiguration>;

/** Versioned — see LoanConfiguration's own doc comment for the pattern this follows. */
@Schema({ timestamps: true, collection: 'branch_rules_configurations' })
export class BranchRulesConfiguration {
  @Prop({ type: Number, required: true })
  maxActiveBranches!: number;

  @Prop({ type: Number, required: true })
  defaultFundLimitKobo!: number;

  @Prop({ type: Boolean, required: true, default: true })
  requireManagerApproval!: boolean;

  @Prop({ type: Number, required: true })
  autoDisbursementLimitKobo!: number;

  @Prop({ type: String, enum: ConfigRecordStatus, required: true, default: ConfigRecordStatus.ACTIVE })
  status!: ConfigRecordStatus;

  @Prop({ type: Types.ObjectId, ref: 'Staff', required: true })
  proposedBy!: Types.ObjectId;

  @Prop({ type: Date, required: true })
  proposedAt!: Date;

  @Prop({ type: Types.ObjectId, ref: 'Staff', required: true })
  approvedBy!: Types.ObjectId;

  @Prop({ type: Date, required: true })
  approvedAt!: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export const BranchRulesConfigurationSchema = SchemaFactory.createForClass(BranchRulesConfiguration);

BranchRulesConfigurationSchema.index({ status: 1 });
