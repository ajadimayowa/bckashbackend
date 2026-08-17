import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

import { RepaymentChannel, RepaymentStatus } from '../../../common/enums/repayment.enums';

export type RepaymentRecordDocument = HydratedDocument<RepaymentRecord>;

@Schema({ _id: false })
export class DisputeDetails {
  @Prop({ type: Types.ObjectId, ref: 'Staff', required: true })
  raisedBy!: Types.ObjectId;

  @Prop({ type: String, required: true })
  reason!: string;

  @Prop({ type: Date, required: true })
  raisedAt!: Date;

  @Prop({ type: String, enum: ['APPROVED', 'REJECTED'], default: null })
  resolution!: 'APPROVED' | 'REJECTED' | null;

  @Prop({ type: Types.ObjectId, ref: 'Staff', default: null })
  resolvedBy!: Types.ObjectId | null;

  @Prop({ type: Date, default: null })
  resolvedAt!: Date | null;

  @Prop({ type: String, default: null })
  note!: string | null;
}

export const DisputeDetailsSchema = SchemaFactory.createForClass(DisputeDetails);

/**
 * DEVIATION from the "nothing persists until workflow approval" pattern used
 * by Group/Staff/FeeDefinition/LoanProduct — same category as Phase 8's Loan
 * and Phase 5's Customer. Created immediately by `RepaymentsService.recordRepayment`,
 * not deferred until approval: this record is evidence of a real-world event
 * (a marketer attesting a customer paid) rather than a proposal that
 * shouldn't exist until approved — see PHASE_9_NOTES.md.
 *
 * `appliedToBalance` is the idempotency guard that makes balance application
 * safe to attempt more than once (a `workflow.approved` event firing twice,
 * a dispute-resolution re-approval) — see `RepaymentsService.applyToBalance`.
 * It is flipped exactly once, by whichever caller's conditional update
 * actually matches (`{_id, appliedToBalance: false}`), never by a plain
 * unconditional `$set`.
 */
@Schema({ timestamps: true, collection: 'repayment_records' })
export class RepaymentRecord {
  @Prop({ type: Types.ObjectId, ref: 'Loan', required: true })
  loanId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'MemberLoanAccount', required: true })
  memberLoanAccountId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Customer', required: true })
  customerId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Branch', required: true })
  branchId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'BranchBankAccount', required: true })
  branchBankAccountId!: Types.ObjectId;

  @Prop({ type: String, enum: RepaymentChannel, required: true })
  channel!: RepaymentChannel;

  @Prop({ type: String, required: true, trim: true })
  transactionReference!: string;

  @Prop({ type: Number, required: true })
  amountKobo!: number;

  @Prop({ type: Date, required: true })
  paymentDate!: Date;

  @Prop({ type: Types.ObjectId, ref: 'Staff', required: true })
  recordedBy!: Types.ObjectId;

  @Prop({ type: Date, required: true })
  recordedAt!: Date;

  @Prop({ type: String, enum: RepaymentStatus, required: true, default: RepaymentStatus.PENDING })
  status!: RepaymentStatus;

  @Prop({ type: String, default: null })
  proofOfPaymentImageKey!: string | null;

  @Prop({ type: Boolean, required: true, default: false })
  appliedToBalance!: boolean;

  @Prop({ type: Number, default: null })
  overpaymentAmountKobo!: number | null;

  @Prop({ type: DisputeDetailsSchema, default: null })
  disputeDetails!: DisputeDetails | null;

  /**
   * Set by `EarlyLiquidationService.linkRepaymentToLiquidation` — when
   * present, this repayment's approval is also checked against the linked
   * `EarlyLiquidationRequest.totalPayableKobo` for completion, in addition
   * to its normal balance-application effect. See PHASE_9_NOTES.md.
   */
  @Prop({ type: Types.ObjectId, ref: 'EarlyLiquidationRequest', default: null })
  linkedLiquidationRequestId!: Types.ObjectId | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const RepaymentRecordSchema = SchemaFactory.createForClass(RepaymentRecord);

// Primary duplicate-entry defense, per the brief.
RepaymentRecordSchema.index({ branchBankAccountId: 1, transactionReference: 1 }, { unique: true });
RepaymentRecordSchema.index({ memberLoanAccountId: 1, status: 1 });
RepaymentRecordSchema.index({ status: 1, createdAt: 1 });
