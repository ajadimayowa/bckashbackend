import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

import { VerificationContext } from '../enums/verification-context.enum';

export type KycRecordDocument = HydratedDocument<KycRecord>;

/** BVN-only — see PHASE_5_NOTES.md on why this has no active producer in this phase. */
@Schema({ _id: false })
export class MismatchFlag {
  @Prop({ type: String, required: true })
  field!: string;

  @Prop({ type: String, required: true })
  submitted!: string;

  @Prop({ type: String, required: true })
  providerValue!: string;
}

export const MismatchFlagSchema = SchemaFactory.createForClass(MismatchFlag);

/**
 * `bvn`/`nin` are ciphertext (EncryptionService) — never plaintext at rest.
 * `bvnConsentDetails` (name/DOB/phone/raw NIBSS payload resolved from the
 * provider) is stored as a single encrypted JSON blob
 * (`bvnConsentDetailsEncrypted`) rather than a queryable embedded
 * sub-document — nothing in this phase needs to query *into* its fields, and
 * it's exactly as sensitive as bvn/nin, so it gets the same at-rest
 * protection rather than a bespoke partial-encryption scheme.
 */
@Schema({ timestamps: true, collection: 'kyc_records' })
export class KycRecord {
  @Prop({ type: Types.ObjectId, ref: 'Customer', required: true, unique: true })
  customerId!: Types.ObjectId;

  @Prop({ type: String, required: true })
  bvn!: string;

  @Prop({ type: String, default: null })
  bvnConsentDetailsEncrypted!: string | null;

  @Prop({ type: String, default: null })
  nin!: string | null;

  @Prop({ type: Date, default: null })
  ninVerifiedAt!: Date | null;

  @Prop({ type: Types.ObjectId, ref: 'Staff', default: null })
  ninManuallyVerifiedBy!: Types.ObjectId | null;

  @Prop({ type: String, default: null })
  ninVerificationNote!: string | null;

  @Prop({ type: String, default: null })
  biometricImageKey!: string | null;

  @Prop({ type: [MismatchFlagSchema], default: [] })
  mismatchFlags!: MismatchFlag[];

  @Prop({ type: Date, default: null })
  bvnVerifiedAt!: Date | null;

  /** Set once BVN + biometric are both done — NIN does not gate this. See recomputeKycStatus. */
  @Prop({ type: Date, default: null })
  kycCompletedAt!: Date | null;

  @Prop({ type: [String], enum: VerificationContext, default: [] })
  lastVerifiedForContext!: VerificationContext[];

  createdAt!: Date;
  updatedAt!: Date;
}

export const KycRecordSchema = SchemaFactory.createForClass(KycRecord);
