import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

import { JournalSourceEvent } from '../../../common/enums/accounting.enums';

export type JournalEntryDocument = HydratedDocument<JournalEntry>;

/** Exactly one of debitKobo/creditKobo is set per line, never both, never neither — enforced by LedgerPostingService, not the schema (Mongoose has no clean "exactly one of" validator). */
@Schema({ _id: false })
export class JournalEntryLine {
  @Prop({ type: Types.ObjectId, ref: 'Account', required: true })
  accountId!: Types.ObjectId;

  @Prop({ type: Number, default: null })
  debitKobo!: number | null;

  @Prop({ type: Number, default: null })
  creditKobo!: number | null;
}

export const JournalEntryLineSchema = SchemaFactory.createForClass(JournalEntryLine);

/**
 * The double-entry ledger's only write surface — see `LedgerPostingService`.
 * Balance validation (Σdebit === Σcredit) happens at the service layer
 * *before* this is ever constructed; nothing here re-checks it, since an
 * unbalanced entry must never reach the database in the first place.
 *
 * `sourceRef = "{sourceEntityType}:{sourceEntityId}"` (for automated
 * postings — see `LedgerPostingService.postIdempotent`) or
 * `"MANUAL:{workflowRequestId}"` (for a manual entry — see
 * `ManualJournalEntryService`) is the idempotency key: a unique index on it
 * is the load-bearing correctness guarantee of this whole phase. See
 * PHASE_10_NOTES.md.
 *
 * `createdBy`/`postedBySystem`: an automated posting has no human actor —
 * `createdBy: null, postedBySystem: true`. A manual entry has a real
 * proposer — `createdBy: <staffId>, postedBySystem: false`. Chosen over a
 * reserved "SYSTEM" staff id (see the brief's own suggested alternative)
 * since this codebase already uses `actorId: string | null` for
 * system-vs-human distinction elsewhere (`AuditService`) — consistent
 * precedent, no fake staff record needed.
 */
@Schema({ timestamps: false, collection: 'journal_entries' })
export class JournalEntry {
  @Prop({ type: String, enum: JournalSourceEvent, required: true })
  sourceEntityType!: JournalSourceEvent;

  @Prop({ type: Types.ObjectId, required: true })
  sourceEntityId!: Types.ObjectId;

  @Prop({ type: String, required: true, unique: true })
  sourceRef!: string;

  @Prop({ type: Types.ObjectId, ref: 'Branch', required: true })
  branchId!: Types.ObjectId;

  @Prop({ type: Date, required: true })
  date!: Date;

  @Prop({ type: [JournalEntryLineSchema], required: true })
  lines!: JournalEntryLine[];

  @Prop({ type: Types.ObjectId, ref: 'Staff', default: null })
  createdBy!: Types.ObjectId | null;

  @Prop({ type: Boolean, required: true, default: false })
  postedBySystem!: boolean;

  @Prop({ type: Date, required: true, default: () => new Date() })
  postedAt!: Date;
}

export const JournalEntrySchema = SchemaFactory.createForClass(JournalEntry);

JournalEntrySchema.index({ branchId: 1, date: 1 });
JournalEntrySchema.index({ sourceEntityType: 1, sourceEntityId: 1 });
JournalEntrySchema.index({ 'lines.accountId': 1, date: 1 });
