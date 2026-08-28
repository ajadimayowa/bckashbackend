import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type LoanConsentChallengeDocument = HydratedDocument<LoanConsentChallenge>;

/**
 * The customer-consent step of raising a loan — a marketer requests a code,
 * it's sent to the customer (SMS/email), and the customer reads it back for
 * the marketer to enter alongside `RaiseLoanApplicationDto`. Same shape as
 * identity's LoginOtpChallenge (only the SHA-256 hash of the code is ever
 * stored; `attemptCount` caps online brute-forcing of a low-entropy 6-digit
 * code; TTL-indexed so an abandoned, never-verified challenge cleans up
 * automatically), but keyed to a Customer rather than a Staff member, and
 * additionally records which staff member requested it (audit trail — who
 * was raising the application this code was for).
 */
@Schema({ timestamps: true, collection: 'loan_consent_challenges' })
export class LoanConsentChallenge {
  @Prop({ type: Types.ObjectId, ref: 'Customer', required: true })
  customerId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Staff', required: true })
  requestedBy!: Types.ObjectId;

  @Prop({ type: String, required: true })
  codeHash!: string;

  @Prop({ type: Number, required: true, default: 0 })
  attemptCount!: number;

  @Prop({ type: Date, required: true })
  expiresAt!: Date;

  @Prop({ type: Date, default: null })
  consumedAt!: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const LoanConsentChallengeSchema = SchemaFactory.createForClass(LoanConsentChallenge);

LoanConsentChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
