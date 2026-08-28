import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

import { ConfigRecordStatus } from '../../../common/enums/platform-config.enums';

export type LoanConfigurationDocument = HydratedDocument<LoanConfiguration>;

/**
 * Versioned — see ConfigRecordStatus's own doc comment. Only ever created by
 * LoanConfigurationService's `workflow.approved` handler for
 * `LOAN_CONFIG/CREATE`; never edited in place. `proposedBy`/`proposedAt`
 * mirror the originating WorkflowRequest's `initiatedBy`/`createdAt`;
 * `approvedBy`/`approvedAt` mirror who took the final APPROVED step and
 * when — copied onto the record itself (rather than requiring a caller to
 * cross-reference WorkflowRequest) so "fetch records by date created / date
 * approved / who approved them" is a plain query against this collection.
 */
@Schema({ timestamps: true, collection: 'loan_configurations' })
export class LoanConfiguration {
  /** Annual rate, basis points (2400 = 24.00%). */
  @Prop({ type: Number, required: true })
  interestRate!: number;

  @Prop({ type: Number, required: true })
  maxLoanAmountKobo!: number;

  @Prop({ type: Number, required: true })
  minLoanAmountKobo!: number;

  @Prop({ type: Number, required: true })
  maxTenureMonths!: number;

  @Prop({ type: Number, required: true })
  gracePeriodDays!: number;

  @Prop({ type: Number, required: true })
  maxGroupSize!: number;

  @Prop({ type: Number, required: true })
  minGroupSize!: number;

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

export const LoanConfigurationSchema = SchemaFactory.createForClass(LoanConfiguration);

LoanConfigurationSchema.index({ status: 1 });
