import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

import { LoanStatus } from '../../../common/enums/loan.enums';

export type LoanDocument = HydratedDocument<Loan>;

/**
 * DEVIATION from the "nothing persists until workflow approval" pattern used by
 * Group/Staff/FeeDefinition/LoanProduct — same category of deviation as Phase 5's
 * Customer. A Loan (and its MemberLoanAccounts) is created immediately when
 * `LoansService.raiseApplication` runs, not deferred until the LOAN/APPROVE_<productId>
 * workflow request is approved, because the brief requires an immediate "loan raised"
 * notification to each member, which needs something concrete to notify about (and a
 * concrete `entityId` to attach to the WorkflowRequest at initiation — see
 * PHASE_8_NOTES.md and WorkflowEngineService.initiate's `entityId` parameter).
 */
@Schema({ timestamps: true, collection: 'loans' })
export class Loan {
  @Prop({ type: Types.ObjectId, ref: 'Group', required: true })
  groupId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'LoanProduct', required: true })
  productId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Branch', required: true })
  branchId!: Types.ObjectId;

  @Prop({ type: Number, required: true })
  tenureMonths!: number;

  /** Kobo — sum of every member's requestedAmountKobo at raise time. */
  @Prop({ type: Number, required: true })
  cumulativeAmountKobo!: number;

  @Prop({ type: String, enum: LoanStatus, required: true, default: LoanStatus.PENDING_APPROVAL })
  status!: LoanStatus;

  @Prop({ type: Types.ObjectId, ref: 'Staff', required: true })
  raisedBy!: Types.ObjectId;

  @Prop({ type: Date, required: true })
  raisedAt!: Date;

  @Prop({ type: Date, default: null })
  approvedAt!: Date | null;

  @Prop({ type: Date, default: null })
  disbursedAt!: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const LoanSchema = SchemaFactory.createForClass(Loan);

LoanSchema.index({ groupId: 1, status: 1 });
LoanSchema.index({ status: 1 });
