import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

import { AccountMappingKey } from '../../../common/enums/accounting.enums';

export type AccountMappingDocument = HydratedDocument<AccountMapping>;

/**
 * Which real `Account` each automated posting debits/credits — data, not a
 * hardcoded switch statement, so it's adjustable without a redeploy. Seeded
 * with defaults at module init (`$setOnInsert`, same idempotent-seed pattern
 * as `RbacService`'s role capabilities — never clobbers an Admin's later
 * edit) — see `AccountingService.onModuleInit` and PHASE_10_NOTES.md for the
 * mapping decisions themselves.
 */
@Schema({ timestamps: true, collection: 'account_mappings' })
export class AccountMapping {
  @Prop({ type: String, enum: AccountMappingKey, required: true, unique: true })
  key!: AccountMappingKey;

  @Prop({ type: Types.ObjectId, ref: 'Account', required: true })
  accountId!: Types.ObjectId;

  createdAt!: Date;
  updatedAt!: Date;
}

export const AccountMappingSchema = SchemaFactory.createForClass(AccountMapping);
