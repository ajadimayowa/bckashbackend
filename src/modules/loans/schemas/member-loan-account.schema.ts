import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

import { DisbursementChannel, MemberLoanAccountStatus } from '../../../common/enums/loan.enums';

export type MemberLoanAccountDocument = HydratedDocument<MemberLoanAccount>;

/**
 * Normalized, persisted shape for one installment — a deliberate unification of
 * Phase 7's two calculation functions' slightly different return shapes
 * (`FlatScheduleInstallment` has no opening/closing balance; `ReducingScheduleInstallment`
 * has both). `openingBalance`/`closingBalance` are derived for FLAT schedules too
 * (trivially — cumulative principal paid down) purely so Phase 9 has one consistent
 * shape to read regardless of which `interestType` the product used. See
 * `LoanVerificationService`'s schedule-normalization helper and PHASE_8_NOTES.md.
 *
 * `dueDate` was NOT part of Phase 8's original shape — flagged there as "not
 * computed... Phase 9 or later may set actual due dates" since Phase 8 had no
 * consumer that needed a real calendar date. Phase 9's penalty sweep is that
 * consumer (see PHASE_9_NOTES.md): each installment is due one calendar month
 * after the previous one, starting one month after `disbursedAt` — computed
 * once, at disbursement time, in `LoanVerificationService.normalizeSchedule`.
 */
@Schema({ _id: false })
export class RepaymentScheduleEntry {
  @Prop({ type: Number, required: true })
  installmentNumber!: number;

  @Prop({ type: Date, required: true })
  dueDate!: Date;

  @Prop({ type: Number, required: true })
  openingBalance!: number;

  @Prop({ type: Number, required: true })
  principalPortion!: number;

  @Prop({ type: Number, required: true })
  interestPortion!: number;

  @Prop({ type: Number, required: true })
  totalDue!: number;

  @Prop({ type: Number, required: true })
  closingBalance!: number;
}

export const RepaymentScheduleEntrySchema = SchemaFactory.createForClass(RepaymentScheduleEntry);

/**
 * One member's slice of a Loan. Created (status: PENDING, no schedule) alongside
 * the parent Loan in `LoansService.raiseApplication` — see Loan's own doc comment
 * for why this doesn't wait for workflow approval. `schedule`/`outstandingBalanceKobo`
 * are only populated at actual disbursement (`LoanVerificationService`'s disbursement
 * transaction), per Phase 7's deferred-generation note — generating a schedule for a
 * loan that might still be rejected or fail verification would be wasted, throwaway
 * work with no consumer.
 */
@Schema({ timestamps: true, collection: 'member_loan_accounts' })
export class MemberLoanAccount {
  @Prop({ type: Types.ObjectId, ref: 'Loan', required: true })
  loanId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Customer', required: true })
  customerId!: Types.ObjectId;

  /** Kobo — this member's own requested amount, not the group cumulative. */
  @Prop({ type: Number, required: true })
  principalAmountKobo!: number;

  @Prop({ type: String, enum: DisbursementChannel, required: true })
  disbursementChannel!: DisbursementChannel;

  @Prop({ type: [RepaymentScheduleEntrySchema], default: [] })
  schedule!: RepaymentScheduleEntry[];

  @Prop({ type: Number, default: null })
  outstandingBalanceKobo!: number | null;

  @Prop({
    type: String,
    enum: MemberLoanAccountStatus,
    required: true,
    default: MemberLoanAccountStatus.PENDING,
  })
  status!: MemberLoanAccountStatus;

  /** CHEQUE_PICKUP only — set by the separate handover-confirmation call, never inside the disbursement transaction. See PHASE_8_NOTES.md. */
  @Prop({ type: Date, default: null })
  chequeHandedOverAt!: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const MemberLoanAccountSchema = SchemaFactory.createForClass(MemberLoanAccount);

MemberLoanAccountSchema.index({ loanId: 1 });
// The index RealLoanStatusPort's hasPendingLoan query relies on (groups module).
MemberLoanAccountSchema.index({ customerId: 1, status: 1 });
