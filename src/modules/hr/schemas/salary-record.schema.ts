import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type SalaryRecordDocument = HydratedDocument<SalaryRecord>;

/**
 * History-preserving, same pattern as `BranchManagerAssignment` (Phase 3) —
 * a salary change creates a new row and closes the prior one's
 * `effectiveTo`, rather than mutating a single row in place. Never
 * hard-deleted.
 *
 * `baseSalaryKoboEncrypted`/`allowancesEncrypted` — encrypted at rest via
 * `EncryptionService` (Phase 5's field-level PII encryption, reused rather
 * than building a second mechanism — see PHASE_12_NOTES.md for why salary
 * counts as sensitive-enough data to extend that requirement to). Stored as
 * plain `String` fields (the encrypted ciphertext), same convention as
 * `Staff.bvnEncrypted`/`KycRecord.bvn` — encryption/decryption happens
 * explicitly in `SalaryService`, never at the schema level (Mongoose
 * set/get transforms run outside Nest's DI container; `EncryptionService`
 * is deliberately DI-friendly instead — see that class's own doc comment).
 *
 * `allowances` is encrypted **as a whole** (one `JSON.stringify` blob, one
 * ciphertext), not per-field — simpler than N separate encrypt operations
 * per allowance line item, and there's no use case here for querying into
 * individual allowance entries at the DB level. Documented as the chosen
 * option per the brief's own "your call, document it."
 */
@Schema({ timestamps: false, collection: 'salary_records' })
export class SalaryRecord {
  @Prop({ type: Types.ObjectId, ref: 'Staff', required: true })
  staffId!: Types.ObjectId;

  @Prop({ type: String, required: true })
  baseSalaryKoboEncrypted!: string;

  /** Encrypted JSON.stringify of `{ name: string; amountKobo: number }[]` — `'[]'` (encrypted) when there are no allowances. */
  @Prop({ type: String, required: true })
  allowancesEncrypted!: string;

  @Prop({ type: Date, required: true })
  effectiveFrom!: Date;

  /** null while this is the current/active record for the staff member. */
  @Prop({ type: Date, default: null })
  effectiveTo!: Date | null;

  @Prop({ type: Types.ObjectId, ref: 'Staff', required: true })
  createdBy!: Types.ObjectId;

  @Prop({ type: Date, required: true, default: () => new Date() })
  createdAt!: Date;
}

export const SalaryRecordSchema = SchemaFactory.createForClass(SalaryRecord);

// Exactly one active (effectiveTo: null) record per staff member at a time
// — same invariant shape as BranchManagerAssignment's own partial unique index.
SalaryRecordSchema.index(
  { staffId: 1, effectiveTo: 1 },
  { unique: true, partialFilterExpression: { effectiveTo: null } },
);
SalaryRecordSchema.index({ staffId: 1, effectiveFrom: -1 });
