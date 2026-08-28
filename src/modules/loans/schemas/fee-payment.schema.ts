import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

import { FeePaymentStatus } from '../../../common/enums/loan.enums';

export type FeePaymentDocument = HydratedDocument<FeePayment>;

/**
 * *** MINIMAL VERSION — SEE PHASE_8_NOTES.md FOR THE OPEN "WHEN ARE PRE_LOAN FEES
 * COLLECTED" QUESTION THIS SCHEMA DELIBERATELY DOES NOT RESOLVE ***
 *
 * Tracks a single fee obligation/payment for one customer against one product's
 * FeeDefinition. Deliberately NOT workflow-mediated — recording that a member
 * paid their registration/form/membership fee at the counter is treated here as
 * an operational cash-collection record (front-desk action), not a maker-checker
 * decision, same category of "not every write needs a workflow chain" reasoning
 * as BranchBankAccount CRUD (Phase 4). `LoansService.raiseApplication` reads
 * (never writes) this collection to *surface* outstanding PRE_LOAN fees per
 * member — it never blocks on them. See PHASE_8_NOTES.md.
 */
@Schema({ timestamps: true, collection: 'fee_payments' })
export class FeePayment {
  @Prop({ type: Types.ObjectId, ref: 'Customer', required: true })
  customerId!: Types.ObjectId;

  /**
   * Added in Phase 10 — needed by `LedgerPostingPort.postFeeCollection`
   * (every `JournalEntry` requires a `branchId`). Resolved from the
   * customer's own `branchId` at record time — see PHASE_10_NOTES.md, which
   * also flags that `recordPayment` never actually posted to the ledger
   * before this phase (a genuine Phase 8 gap, not just an unused stub).
   */
  @Prop({ type: Types.ObjectId, ref: 'Branch', required: true })
  branchId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'LoanProduct', required: true })
  productId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'FeeDefinition', required: true })
  feeDefinitionId!: Types.ObjectId;

  @Prop({ type: Number, required: true })
  amountKobo!: number;

  @Prop({
    type: String,
    enum: FeePaymentStatus,
    required: true,
    default: FeePaymentStatus.PENDING,
  })
  status!: FeePaymentStatus;

  @Prop({ type: Types.ObjectId, ref: 'Staff', default: null })
  recordedBy!: Types.ObjectId | null;

  @Prop({ type: Date, default: null })
  recordedAt!: Date | null;

  /** Which bank account the fee was paid into — free text (branch cash account, bank name, etc.), collected at record time. */
  @Prop({ type: String, default: null })
  accountPaidTo!: string | null;

  /** Teller/transfer reference for this payment, collected at record time — never generated, always what was actually given. */
  @Prop({ type: String, default: null })
  paymentReference!: string | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const FeePaymentSchema = SchemaFactory.createForClass(FeePayment);

FeePaymentSchema.index({ customerId: 1, productId: 1, feeDefinitionId: 1 }, { unique: true });
FeePaymentSchema.index({ customerId: 1, status: 1 });
