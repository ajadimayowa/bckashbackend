import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

import { CustomerStatus, KycStatus } from '../../../common/enums/customer.enums';

export type CustomerDocument = HydratedDocument<Customer>;

/**
 * Created once BVN consent is confirmed (see CustomerService.confirmBvnConsent)
 * — pre-filled from the provider's resolved details, not entered blind. See
 * PHASE_5_NOTES.md for why this is a deliberate deviation from Phase 3's
 * staff pattern (nothing persisted until workflow approval): an
 * OTP-confirmed BVN identity already justifies persisting a draft record,
 * held at PENDING_APPROVAL until the marketer finishes the remaining
 * details and explicitly submits.
 */
@Schema({ timestamps: true, collection: 'customers' })
export class Customer {
  @Prop({ type: String, required: true, trim: true })
  firstName!: string;

  @Prop({ type: String, required: true, trim: true })
  lastName!: string;

  @Prop({ type: String, required: true, trim: true })
  phoneNumber!: string;

  @Prop({ type: String, default: null, lowercase: true, trim: true })
  email!: string | null;

  @Prop({ type: String, default: null })
  address!: string | null;

  @Prop({ type: Types.ObjectId, ref: 'Branch', required: true })
  branchId!: Types.ObjectId;

  @Prop({
    type: String,
    enum: CustomerStatus,
    required: true,
    default: CustomerStatus.PENDING_APPROVAL,
  })
  status!: CustomerStatus;

  @Prop({ type: String, enum: KycStatus, required: true, default: KycStatus.INCOMPLETE })
  kycStatus!: KycStatus;

  @Prop({ type: Types.ObjectId, ref: 'Staff', required: true })
  createdBy!: Types.ObjectId;

  createdAt!: Date;
  updatedAt!: Date;
}

export const CustomerSchema = SchemaFactory.createForClass(Customer);

CustomerSchema.index({ branchId: 1, status: 1 });
CustomerSchema.index({ phoneNumber: 1 });
