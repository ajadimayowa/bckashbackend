import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type BranchDocument = HydratedDocument<Branch>;

/**
 * Branch bank accounts and funding are deferred to Phase 4 — this phase only
 * owns the branch entity itself and its manager assignment history (see
 * branch-manager-assignment.schema.ts), because both are tightly coupled to
 * staff/org structure (identity module).
 */
@Schema({ timestamps: true, collection: 'branches' })
export class Branch {
  @Prop({ type: String, required: true, trim: true })
  name!: string;

  @Prop({ type: String, required: true, unique: true, uppercase: true, trim: true })
  code!: string;

  @Prop({ type: String, default: null })
  address!: string | null;

  @Prop({ type: String, default: null, trim: true })
  phone!: string | null;

  @Prop({ type: String, default: null, trim: true, lowercase: true })
  email!: string | null;

  @Prop({ type: Boolean, required: true, default: true })
  active!: boolean;
}

export const BranchSchema = SchemaFactory.createForClass(Branch);
