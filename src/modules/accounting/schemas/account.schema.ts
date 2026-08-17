import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

import { AccountType } from '../../../common/enums/accounting.enums';

export type AccountDocument = HydratedDocument<Account>;

/**
 * Chart of accounts. Deliberately NOT workflow-mediated — same reasoning as
 * Phase 3's org-structure CRUD (Department/Unit/Branch) and Phase 4's
 * BranchBankAccount CRUD: low-risk, easily reversible structural
 * configuration, not itself a money movement. ASSUMPTION (flagged, see
 * PHASE_10_NOTES.md) — confirm, since this is financial-adjacent structure
 * and the coop may want more control here than, say, branch CRUD.
 */
@Schema({ timestamps: true, collection: 'accounts' })
export class Account {
  /** Unique, e.g. "1010", "4020" — standard chart-of-accounts numbering. Admin-assigned, not auto-generated. */
  @Prop({ type: String, required: true, unique: true, trim: true })
  code!: string;

  @Prop({ type: String, required: true, trim: true })
  name!: string;

  @Prop({ type: String, enum: AccountType, required: true })
  type!: AccountType;

  /** Optional hierarchical grouping — e.g. a "Cash & Bank" parent over several branch-specific sub-accounts. Not enforced/validated beyond existence at creation time. */
  @Prop({ type: Types.ObjectId, ref: 'Account', default: null })
  parentAccountId!: Types.ObjectId | null;

  @Prop({ type: Boolean, required: true, default: true })
  active!: boolean;

  createdAt!: Date;
  updatedAt!: Date;
}

export const AccountSchema = SchemaFactory.createForClass(Account);

AccountSchema.index({ type: 1, active: 1 });
