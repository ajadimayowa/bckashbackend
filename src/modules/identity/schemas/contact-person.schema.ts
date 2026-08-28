import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

/**
 * Sub-document only — never its own collection, never queried independently
 * of the Staff it embeds into. Shared shape for both `Staff.nextOfKin` and
 * `Staff.reference` (identical fields), so one class backs both rather than
 * two near-duplicate ones — see StaffOnboarding.tsx's own next-of-kin and
 * reference field groups, which this mirrors.
 */
@Schema({ _id: false })
export class ContactPerson {
  @Prop({ type: String, default: null, trim: true })
  name!: string | null;

  @Prop({ type: String, default: null, trim: true })
  relationship!: string | null;

  @Prop({ type: String, default: null, trim: true })
  phoneNumber!: string | null;

  @Prop({ type: String, default: null, trim: true })
  address!: string | null;
}

export const ContactPersonSchema = SchemaFactory.createForClass(ContactPerson);
