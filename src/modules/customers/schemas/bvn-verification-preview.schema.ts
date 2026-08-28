import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';

import { MismatchFlag, MismatchFlagSchema } from './kyc-record.schema';

export type BvnVerificationPreviewDocument = HydratedDocument<BvnVerificationPreview>;

const PREVIEW_TTL_MINUTES = 15;
export const BVN_VERIFICATION_PREVIEW_TTL_MS = PREVIEW_TTL_MINUTES * 60_000;

/**
 * "Step 1" of customer intake is now genuinely just a preview — verifying a
 * BVN against the provider (and checking it isn't a duplicate/already-
 * registered phone number) no longer creates a Customer/KycRecord by
 * itself; see CustomerService.previewBvn's own doc comment. This is the
 * short-lived, server-side record of what the provider actually resolved,
 * so the real creation step (CustomerService.confirmCustomerFromPreview)
 * never has to trust whatever the frontend echoes back as "the provider's
 * values" — it re-reads them from here instead. Same TTL-indexed,
 * consumed-once shape as LoginOtpChallenge/LoanConsentChallenge, so an
 * abandoned, never-confirmed preview cleans up automatically rather than
 * lingering with a live BVN/PII payload sitting around.
 */
@Schema({ timestamps: true, collection: 'bvn_verification_previews' })
export class BvnVerificationPreview {
  // Explicit SchemaTypes.ObjectId (not Types.ObjectId) — see
  // branch-funding.schema.ts's own doc comment on why @nestjs/mongoose
  // silently produces an uncast Mixed field otherwise in this codebase's
  // Mongoose 8 setup. New schema, so no reason to repeat that mistake here.
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Branch', required: true })
  branchId!: Types.ObjectId;

  /** Only this staff member may confirm this preview — see confirmCustomerFromPreview. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Staff', required: true })
  verifiedBy!: Types.ObjectId;

  @Prop({ type: String, required: true })
  bvnEncrypted!: string;

  /** Deterministic hash — re-checked at confirm time in case another preview for the same BVN was confirmed first. */
  @Prop({ type: String, required: true })
  bvnHash!: string;

  // The provider's resolved identity — plaintext, same sensitivity level
  // already accepted for these same fields once they land on Customer
  // itself (see that schema's own fields). Only the BVN and the raw
  // provider payload below get field-level encryption, matching KycRecord's
  // own convention.
  @Prop({ type: String, required: true })
  firstName!: string;

  @Prop({ type: String, required: true })
  lastName!: string;

  @Prop({ type: String, required: true })
  phoneNumber!: string;

  /** The full provider response, encrypted — copied verbatim onto KycRecord.bvnConsentDetailsEncrypted at confirm time. */
  @Prop({ type: String, required: true })
  rawDetailsEncrypted!: string;

  /** Computed once here (against whatever was submitted at preview time) — copied onto KycRecord.mismatchFlags, resolved, at confirm time. */
  @Prop({ type: [MismatchFlagSchema], default: [] })
  mismatchFlags!: MismatchFlag[];

  @Prop({ type: Date, default: null })
  consumedAt!: Date | null;

  @Prop({ type: Date, required: true })
  expiresAt!: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export const BvnVerificationPreviewSchema = SchemaFactory.createForClass(BvnVerificationPreview);

BvnVerificationPreviewSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
