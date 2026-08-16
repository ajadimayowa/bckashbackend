import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

import { BranchBankAccountPurpose } from '../../../common/enums/branch.enums';

export type BranchBankAccountDocument = HydratedDocument<BranchBankAccount>;

/**
 * `active: false` retires an account without deleting it — Phase 9's
 * repayment records will reference these by id and must always resolve to a
 * real document, even for a retired account. No delete endpoint exists for
 * this reason; see PHASE_4_NOTES.md.
 */
@Schema({ timestamps: true, collection: 'branch_bank_accounts' })
export class BranchBankAccount {
  @Prop({ type: Types.ObjectId, ref: 'Branch', required: true })
  branchId!: Types.ObjectId;

  @Prop({ type: String, required: true, trim: true })
  bankName!: string;

  @Prop({ type: String, required: true, trim: true })
  accountNumber!: string;

  @Prop({ type: String, required: true, trim: true })
  accountName!: string;

  @Prop({ type: String, enum: BranchBankAccountPurpose, required: true })
  purpose!: BranchBankAccountPurpose;

  @Prop({ type: Boolean, required: true, default: true })
  active!: boolean;

  createdAt!: Date;
  updatedAt!: Date;
}

export const BranchBankAccountSchema = SchemaFactory.createForClass(BranchBankAccount);

// The same real-world bank account must never be registered twice, even
// across different branches — a global uniqueness constraint, not scoped to branchId.
BranchBankAccountSchema.index({ bankName: 1, accountNumber: 1 }, { unique: true });
BranchBankAccountSchema.index({ branchId: 1, active: 1 });
