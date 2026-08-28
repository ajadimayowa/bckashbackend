import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type OrganisationDocument = HydratedDocument<Organisation>;

/** Embedded, not a separate collection — "an array of accounts on the org profile", not independently queried/referenced elsewhere. Same `_id: false` embedded-subdocument pattern as WorkflowStepRecord. */
@Schema({ _id: false })
export class OrganisationAccountDetail {
  @Prop({ type: String, required: true, trim: true })
  bankName!: string;

  @Prop({ type: String, required: true, trim: true })
  accountNumber!: string;

  @Prop({ type: String, required: true, trim: true })
  accountName!: string;
}

export const OrganisationAccountDetailSchema =
  SchemaFactory.createForClass(OrganisationAccountDetail);

/**
 * Singleton — exactly one document, ever. Enforced at the service layer
 * (`OrganisationService.create` throws if one already exists), not via a
 * unique-index trick, matching this codebase's usual "business rule lives
 * in the service, schema stays a plain data shape" convention. See
 * OrganisationService for the full reasoning.
 */
@Schema({ timestamps: true, collection: 'organisation' })
export class Organisation {
  @Prop({ type: String, required: true, trim: true })
  nameOfOrg!: string;

  @Prop({ type: String, required: true, trim: true })
  address!: string;

  @Prop({ type: [String], required: true })
  phoneNumbers!: string[];

  @Prop({ type: [OrganisationAccountDetailSchema], required: true, default: [] })
  organisationAccountDetails!: OrganisationAccountDetail[];

  @Prop({ type: String, required: true })
  briefHistory!: string;

  @Prop({ type: String, required: true, unique: true, trim: true })
  businessRegNumber!: string;

  /**
   * Central Bank of Nigeria microfinance banking license number — distinct
   * from `businessRegNumber` (the CAC/company-registration number). Optional:
   * not every deployment will have this on hand at initial setup time.
   */
  @Prop({ type: String, default: null, trim: true })
  cbnLicenseNumber!: string | null;

  /** Optional — a single primary contact address, distinct from `phoneNumbers` (which has no email equivalent). */
  @Prop({ type: String, default: null, lowercase: true, trim: true })
  contactEmail!: string | null;

  /** S3 object key only, never raw bytes — see EncryptionModule-adjacent S3Adapter convention (KycRecord.biometricImageKey etc.). Optional, per the brief. */
  @Prop({ type: String, default: null })
  cacDocKey!: string | null;

  @Prop({ type: Types.ObjectId, ref: 'Staff', required: true })
  createdBy!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Staff', default: null })
  updatedBy!: Types.ObjectId | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const OrganisationSchema = SchemaFactory.createForClass(Organisation);
