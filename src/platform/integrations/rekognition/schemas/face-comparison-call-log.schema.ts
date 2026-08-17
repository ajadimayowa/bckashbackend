import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type FaceComparisonCallLogDocument = HydratedDocument<FaceComparisonCallLog>;

/**
 * Provider-call reconciliation log for every AWS Rekognition CompareFaces call,
 * success or failure — same purpose/discipline as BvnCallLog (platform/integrations/bvn):
 * "how many billable provider calls did we make and what did they return", never
 * the raw compared images (see FaceComparisonAdapter's doc comment — those are
 * never persisted here or anywhere).
 */
@Schema({ timestamps: false, collection: 'face_comparison_call_logs' })
export class FaceComparisonCallLog {
  @Prop({ type: String, default: null })
  calledBy!: string | null;

  @Prop({ type: Types.ObjectId, ref: 'Loan', default: null })
  loanId!: Types.ObjectId | null;

  @Prop({ type: Types.ObjectId, ref: 'MemberLoanAccount', default: null })
  memberLoanAccountId!: Types.ObjectId | null;

  @Prop({ type: Types.ObjectId, ref: 'Customer', default: null })
  customerId!: Types.ObjectId | null;

  @Prop({ type: String, required: true })
  sourceImageKey!: string;

  @Prop({ type: Boolean, required: true })
  isMatch!: boolean;

  @Prop({ type: Number, required: true })
  similarityPercent!: number;

  @Prop({ type: Number, required: true })
  matchThreshold!: number;

  @Prop({ type: Date, required: true, default: () => new Date() })
  calledAt!: Date;

  @Prop({ type: String, default: null })
  errorMessage!: string | null;
}

export const FaceComparisonCallLogSchema = SchemaFactory.createForClass(FaceComparisonCallLog);

FaceComparisonCallLogSchema.index({ loanId: 1, memberLoanAccountId: 1, calledAt: -1 });
FaceComparisonCallLogSchema.index({ customerId: 1, calledAt: -1 });
