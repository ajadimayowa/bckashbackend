import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type BranchFundBalanceDocument = HydratedDocument<BranchFundBalance>;

/**
 * Materialized balance — Σ verified fundings − Σ disbursed amounts − Σ other
 * approved outflows — not computed on read. One document per branch
 * (enforced by the unique index below), initialized at `availableAmount: 0`
 * when the branch is created (see branches.service.ts's `branch.created`
 * event + this module's listener). All mutation goes through
 * BranchFundBalanceService.credit/debit — never write `availableAmount`
 * directly from anywhere else.
 */
@Schema({ timestamps: { createdAt: false, updatedAt: true }, collection: 'branch_fund_balances' })
export class BranchFundBalance {
  @Prop({ type: Types.ObjectId, ref: 'Branch', required: true, unique: true })
  branchId!: Types.ObjectId;

  /** Kobo — integer, never negative (guarded by BranchFundBalanceService.debit's atomic $gte check). */
  @Prop({ type: Number, required: true, default: 0 })
  availableAmount!: number;

  updatedAt!: Date;
}

export const BranchFundBalanceSchema = SchemaFactory.createForClass(BranchFundBalance);
