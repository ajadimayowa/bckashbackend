import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import { BvnCallEntityType, BvnCallStep } from '../enums/bvn-call-log.enums';

export type BvnCallLogDocument = HydratedDocument<BvnCallLog>;

/**
 * Provider-call reconciliation log — every call to the BVN provider,
 * success or failure, including the internal auth login. Complementary to,
 * and never conflated with, the generic `AuditService` KYC_DATA_READ trail:
 * this collection answers "how many billable provider calls did we make and
 * did they succeed", the audit trail answers "who looked at this customer's
 * KYC data and when." See PHASE_5_NOTES.md.
 */
@Schema({ timestamps: false, collection: 'bvn_call_logs' })
export class BvnCallLog {
  @Prop({ type: String, enum: BvnCallStep, required: true })
  step!: BvnCallStep;

  /** Encrypted at rest — null for AUTH_LOGIN, which isn't tied to a specific BVN. */
  @Prop({ type: String, default: null })
  bvn!: string | null;

  @Prop({ type: Boolean, required: true })
  success!: boolean;

  @Prop({ type: Number, default: null })
  providerStatusCode!: number | null;

  @Prop({ type: Date, required: true, default: () => new Date() })
  calledAt!: Date;

  /** staffId — null for a system-triggered call (e.g. a proactive token refresh). */
  @Prop({ type: String, default: null })
  calledBy!: string | null;

  @Prop({ type: String, enum: BvnCallEntityType, default: null })
  calledForEntityType!: BvnCallEntityType | null;

  @Prop({ type: String, default: null })
  calledForEntityId!: string | null;

  /** Safe, non-PII context only — never the raw provider response body (see the "never log PII" rule). */
  @Prop({ type: String, default: null })
  errorMessage!: string | null;
}

export const BvnCallLogSchema = SchemaFactory.createForClass(BvnCallLog);

BvnCallLogSchema.index({ calledForEntityType: 1, calledForEntityId: 1, calledAt: -1 });
BvnCallLogSchema.index({ step: 1, success: 1, calledAt: -1 });
