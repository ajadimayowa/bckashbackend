import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type SmsCallLogDocument = HydratedDocument<SmsCallLog>;

/**
 * Provider-call reconciliation log — every call to Termii, success or
 * failure, since SMS is billed per message. Same reconciliation discipline
 * as `BvnCallLog` (see PHASE_5_NOTES.md) — this collection answers "how many
 * billable SMS calls did we make and did they succeed," never a substitute
 * for the generic `AuditService` trail. See PHASE_11_NOTES.md.
 */
@Schema({ timestamps: false, collection: 'sms_call_logs' })
export class SmsCallLog {
  /** Normalized (234... form, no leading +) — see phone-number.util.ts. */
  @Prop({ type: String, required: true })
  toPhoneNumber!: string;

  @Prop({ type: Boolean, required: true })
  success!: boolean;

  @Prop({ type: Number, default: null })
  providerStatusCode!: number | null;

  @Prop({ type: String, default: null })
  providerMessageId!: string | null;

  @Prop({ type: String, default: null })
  errorMessage!: string | null;

  @Prop({ type: Date, required: true, default: () => new Date() })
  calledAt!: Date;
}

export const SmsCallLogSchema = SchemaFactory.createForClass(SmsCallLog);

SmsCallLogSchema.index({ calledAt: -1 });
SmsCallLogSchema.index({ success: 1, calledAt: -1 });
