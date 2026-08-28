import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

import { CustomerStatus, KycStatus } from '../../../common/enums/customer.enums';

export type CustomerDocument = HydratedDocument<Customer>;

/** Free-text next-of-kin contact — not KYC data, never encrypted, purely informational. */
@Schema({ _id: false })
export class NextOfKin {
  @Prop({ type: String, required: true, trim: true })
  fullName!: string;

  @Prop({ type: String, required: true, trim: true })
  phoneNumber!: string;

  @Prop({ type: String, default: null, trim: true })
  relationship!: string | null;
}

export const NextOfKinSchema = SchemaFactory.createForClass(NextOfKin);

/** Up to 3 per customer, order-significant (see UpdateOnboardingDetailsDto) — same free-text, non-KYC treatment as NextOfKin. */
@Schema({ _id: false })
export class Guarantor {
  @Prop({ type: String, required: true, trim: true })
  fullName!: string;

  @Prop({ type: String, required: true, trim: true })
  phoneNumber!: string;

  @Prop({ type: String, default: null, lowercase: true, trim: true })
  email!: string | null;

  @Prop({ type: String, default: null, trim: true })
  address!: string | null;

  @Prop({ type: String, default: null, trim: true })
  relationship!: string | null;

  @Prop({ type: String, default: null, trim: true })
  occupation!: string | null;
}

export const GuarantorSchema = SchemaFactory.createForClass(Guarantor);

@Schema({ _id: false })
export class CustomerReference {
  @Prop({ type: String, required: true, trim: true })
  fullName!: string;

  @Prop({ type: String, required: true, trim: true })
  phoneNumber!: string;

  @Prop({ type: String, default: null, trim: true })
  address!: string | null;

  @Prop({ type: String, default: null, trim: true })
  relationship!: string | null;

  @Prop({ type: String, default: null, trim: true })
  occupation!: string | null;

  @Prop({ type: String, default: null, trim: true })
  yearsKnown!: string | null;
}

export const CustomerReferenceSchema = SchemaFactory.createForClass(CustomerReference);

export enum EditPrivilegeStatus {
  NONE = 'NONE',
  PENDING = 'PENDING',
  GRANTED = 'GRANTED',
  REJECTED = 'REJECTED',
}

/**
 * Once a Customer is ACTIVE, `updateOnboardingDetails` refuses to touch it
 * unless `status === GRANTED` — the creator must first request permission
 * (reason + a photo of the customer's signature), and only Admin/SuperAdmin/
 * Approver can grant it. Consumed (reset to NONE) the moment it's actually
 * used for an edit, so a fresh request is needed for each subsequent one —
 * same one-shot spirit as Customer.disabledReason.
 */
@Schema({ _id: false })
export class EditPrivilege {
  @Prop({ type: String, enum: EditPrivilegeStatus, required: true, default: EditPrivilegeStatus.NONE })
  status!: EditPrivilegeStatus;

  @Prop({ type: String, default: null })
  reason!: string | null;

  @Prop({ type: String, default: null })
  signatureImageKey!: string | null;

  @Prop({ type: Types.ObjectId, ref: 'Staff', default: null })
  requestedBy!: Types.ObjectId | null;

  @Prop({ type: Date, default: null })
  requestedAt!: Date | null;

  @Prop({ type: Types.ObjectId, ref: 'Staff', default: null })
  decidedBy!: Types.ObjectId | null;

  @Prop({ type: Date, default: null })
  decidedAt!: Date | null;

  @Prop({ type: String, default: null })
  decisionComment!: string | null;
}

export const EditPrivilegeSchema = SchemaFactory.createForClass(EditPrivilege);

/**
 * Created once BVN consent is confirmed (see CustomerService.confirmBvnConsent)
 * — pre-filled from the provider's resolved details, not entered blind. See
 * PHASE_5_NOTES.md for why this is a deliberate deviation from Phase 3's
 * staff pattern (nothing persisted until workflow approval): an
 * OTP-confirmed BVN identity already justifies persisting a draft record,
 * held at DRAFT (creator-only visible) until the marketer finishes the
 * remaining details and explicitly submits via `submitForApproval`, which
 * flips it to PENDING_APPROVAL and creates the real WorkflowRequest.
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
    default: CustomerStatus.DRAFT,
  })
  status!: CustomerStatus;

  @Prop({ type: String, enum: KycStatus, required: true, default: KycStatus.INCOMPLETE })
  kycStatus!: KycStatus;

  @Prop({ type: Types.ObjectId, ref: 'Staff', required: true })
  createdBy!: Types.ObjectId;

  /** Set only when `status` is DISABLED — see CustomerService.disable/enable, same pattern as Staff's disable fields. */
  @Prop({ type: String, default: null })
  disabledReason!: string | null;

  @Prop({ type: Types.ObjectId, ref: 'Staff', default: null })
  disabledBy!: Types.ObjectId | null;

  @Prop({ type: Date, default: null })
  disabledAt!: Date | null;

  /** Filled in via PATCH /customers/:id/onboarding-details, same creator-only/PENDING_APPROVAL-only rules as address/email/nin. Not KYC — no verification concept for these. */
  @Prop({ type: NextOfKinSchema, default: null })
  nextOfKin!: NextOfKin | null;

  @Prop({ type: [GuarantorSchema], default: [] })
  guarantors!: Guarantor[];

  @Prop({ type: CustomerReferenceSchema, default: null })
  reference!: CustomerReference | null;

  /** Gate on editing an ACTIVE customer's profile details — see EditPrivilege's own doc comment. */
  @Prop({ type: EditPrivilegeSchema, default: () => ({}) })
  editPrivilege!: EditPrivilege;

  createdAt!: Date;
  updatedAt!: Date;
}

export const CustomerSchema = SchemaFactory.createForClass(Customer);

CustomerSchema.index({ branchId: 1, status: 1 });
CustomerSchema.index({ phoneNumber: 1 });
CustomerSchema.index({ createdBy: 1 });
