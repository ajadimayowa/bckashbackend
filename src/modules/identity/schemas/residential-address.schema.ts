import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

/**
 * Sub-document only. Where the staff member *lives* — distinct from
 * `Staff.branchId`, which is where they *work*.
 */
@Schema({ _id: false })
export class ResidentialAddress {
  @Prop({ type: String, default: null, trim: true })
  state!: string | null;

  @Prop({ type: String, default: null, trim: true })
  city!: string | null;

  @Prop({ type: String, default: null, trim: true })
  street!: string | null;
}

export const ResidentialAddressSchema = SchemaFactory.createForClass(ResidentialAddress);
