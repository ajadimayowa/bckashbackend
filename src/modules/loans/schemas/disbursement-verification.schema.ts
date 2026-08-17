import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

import {
  DisbursementChannel,
  DisbursementVerificationStatus,
} from '../../../common/enums/loan.enums';

export type DisbursementVerificationDocument = HydratedDocument<DisbursementVerification>;

@Schema({ _id: false })
export class BvnRecheckResult {
  @Prop({ type: String, enum: ['PASSED', 'FAILED'], required: true })
  status!: 'PASSED' | 'FAILED';

  @Prop({ type: Date, required: true })
  verifiedAt!: Date;

  /**
   * No natural provider transaction reference is exposed by
   * `BvnVerificationAdapter`'s public contract (see PHASE_8_NOTES.md) — this is a
   * locally-generated correlation id, not something returned by the BVN provider
   * itself.
   */
  @Prop({ type: String, required: true })
  providerRef!: string;
}

export const BvnRecheckResultSchema = SchemaFactory.createForClass(BvnRecheckResult);

@Schema({ _id: false })
export class FacialMatchResult {
  @Prop({ type: String, enum: ['PASSED', 'FAILED'], required: true })
  status!: 'PASSED' | 'FAILED';

  @Prop({ type: Number, required: true })
  similarityPercent!: number;

  @Prop({ type: String, required: true })
  rekognitionRef!: string;

  @Prop({ type: Date, required: true })
  verifiedAt!: Date;
}

export const FacialMatchResultSchema = SchemaFactory.createForClass(FacialMatchResult);

/**
 * One per (loanId, memberLoanAccountId) — upserted by
 * `LoanVerificationService.initiateMemberVerification` so a retry (e.g. after a
 * transient BVN provider error) simply overwrites the same record rather than
 * accumulating duplicates. `channel`/`officeId`/`officerId` are populated
 * identically regardless of whether this originates from a customer's mobile
 * self-service flow (TRANSFER) or an officer's in-person flow (CHEQUE_PICKUP) —
 * confirmed per the brief: the cheque-pickup officer check IS the pre-disbursement
 * verification for that channel, not a second layer on top of it. See
 * PHASE_8_NOTES.md.
 *
 * `resolvedBy`/`resolvedAt`/`resolutionNote` are an additive extension beyond the
 * brief's literal shape — needed to record *how* an ESCALATED verification was
 * resolved (`LoansService.resolveEscalation`) without inventing an extra status
 * value; `status` deliberately stays ESCALATED even after resolution (the
 * resolution fields are the "this was handled" marker) — see PHASE_8_NOTES.md.
 */
@Schema({ timestamps: true, collection: 'disbursement_verifications' })
export class DisbursementVerification {
  @Prop({ type: Types.ObjectId, ref: 'Loan', required: true })
  loanId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'MemberLoanAccount', required: true })
  memberLoanAccountId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Customer', required: true })
  customerId!: Types.ObjectId;

  @Prop({ type: String, enum: DisbursementChannel, required: true })
  channel!: DisbursementChannel;

  /** CHEQUE_PICKUP only. ASSUMPTION: "office" == Branch — no separate Office entity exists in this codebase. See PHASE_8_NOTES.md. */
  @Prop({ type: Types.ObjectId, ref: 'Branch', default: null })
  officeId!: Types.ObjectId | null;

  /** CHEQUE_PICKUP only — the staff member performing the in-person check. */
  @Prop({ type: Types.ObjectId, ref: 'Staff', default: null })
  officerId!: Types.ObjectId | null;

  @Prop({ type: BvnRecheckResultSchema, default: null })
  bvnRecheck!: BvnRecheckResult | null;

  @Prop({ type: FacialMatchResultSchema, default: null })
  facialMatch!: FacialMatchResult | null;

  @Prop({
    type: String,
    enum: DisbursementVerificationStatus,
    required: true,
    default: DisbursementVerificationStatus.PENDING,
  })
  status!: DisbursementVerificationStatus;

  @Prop({ type: String, default: null })
  escalationReason!: string | null;

  @Prop({ type: Types.ObjectId, ref: 'Staff', default: null })
  resolvedBy!: Types.ObjectId | null;

  @Prop({ type: Date, default: null })
  resolvedAt!: Date | null;

  @Prop({ type: String, default: null })
  resolutionNote!: string | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const DisbursementVerificationSchema =
  SchemaFactory.createForClass(DisbursementVerification);

DisbursementVerificationSchema.index({ loanId: 1, memberLoanAccountId: 1 }, { unique: true });
DisbursementVerificationSchema.index({ status: 1 });
