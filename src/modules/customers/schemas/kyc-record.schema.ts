import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

import { IdDocumentType } from '../../../common/enums/customer.enums';
import { VerificationContext } from '../enums/verification-context.enum';

export type KycRecordDocument = HydratedDocument<KycRecord>;

/**
 * BVN-only — recorded by CustomerService.buildMismatchFlags whenever the
 * marketer's submitted fullName/phoneNumber (see VerifyBvnDto) doesn't match
 * what the provider resolved. The Customer record is created with the
 * *provider's* values by default; `resolvedAt`/`resolvedBy`/`resolution`/
 * `reason` are filled in once the creator explicitly picks a side via
 * CustomerService.resolveIdentityMismatch — a required `reason` only when
 * they choose to override with what they submitted (KEPT_PROVIDER_VALUE
 * needs no justification, USED_SUBMITTED_VALUE does).
 */
@Schema({ _id: false })
export class MismatchFlag {
  @Prop({ type: String, required: true })
  field!: string;

  @Prop({ type: String, required: true })
  submitted!: string;

  @Prop({ type: String, required: true })
  providerValue!: string;

  @Prop({ type: Date, default: null })
  resolvedAt!: Date | null;

  @Prop({ type: Types.ObjectId, ref: 'Staff', default: null })
  resolvedBy!: Types.ObjectId | null;

  @Prop({ type: String, enum: ['KEPT_PROVIDER_VALUE', 'USED_SUBMITTED_VALUE'], default: null })
  resolution!: 'KEPT_PROVIDER_VALUE' | 'USED_SUBMITTED_VALUE' | null;

  /** Required iff resolution === USED_SUBMITTED_VALUE. */
  @Prop({ type: String, default: null })
  reason!: string | null;
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

  /**
   * Deterministic HMAC of the plaintext BVN (see EncryptionService.hash) —
   * `bvn` itself is randomized ciphertext (a fresh IV per encryption), so it
   * can never be queried for equality. This is what
   * CustomerService.verifyBvnAndCreateCustomer checks *before* even calling
   * the provider, to reject a BVN already registered to another customer.
   * Optional + sparse (not `required`) purely so pre-existing KycRecord
   * documents from before this field existed don't fail validation — see
   * scripts/backfill-bvn-hash.ts for backfilling those.
   */
  @Prop({ type: String, default: null })
  bvnHash!: string | null;

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

  /** A photo of the customer's ID document (NIN slip, voter's card, ...) — same upload/signed-URL pattern as biometricImageKey, never gates kycStatus. */
  @Prop({ type: String, default: null })
  idDocumentImageKey!: string | null;

  /** Which kind of document idDocumentImageKey is a photo of — set alongside it via POST /customers/:id/id-document. */
  @Prop({ type: String, enum: IdDocumentType, default: null })
  idDocumentType!: IdDocumentType | null;

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

// Sparse — see bvnHash's own doc comment for why this isn't a plain `unique: true` prop option.
KycRecordSchema.index({ bvnHash: 1 }, { unique: true, sparse: true });
