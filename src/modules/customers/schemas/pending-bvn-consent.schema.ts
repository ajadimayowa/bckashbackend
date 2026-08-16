import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type PendingBvnConsentDocument = HydratedDocument<PendingBvnConsent>;

/**
 * Short-lived bridge across the two-request BVN consent flow (OTP sent, then
 * a human enters it) — exists before any Customer/KycRecord does. `bvn` and
 * `consentToken` are both encrypted at rest: the token embeds PII in its
 * (unverified-by-us) JWT payload, so it gets the same protection as the raw
 * BVN. TTL-indexed so expired, never-confirmed attempts clean up automatically.
 */
@Schema({ timestamps: true, collection: 'pending_bvn_consents' })
export class PendingBvnConsent {
  @Prop({ type: String, required: true })
  bvn!: string;

  @Prop({ type: String, required: true })
  consentToken!: string;

  @Prop({ type: Types.ObjectId, ref: 'Staff', required: true })
  initiatedBy!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Branch', required: true })
  branchId!: Types.ObjectId;

  @Prop({ type: Date, required: true })
  expiresAt!: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export const PendingBvnConsentSchema = SchemaFactory.createForClass(PendingBvnConsent);

PendingBvnConsentSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
