import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

import { ModuleName, StaffRole, StaffStatus } from '../../../common/enums/identity.enums';

export type StaffDocument = HydratedDocument<Staff>;

/**
 * `passwordHash` is `select: false` — excluded from every query by default,
 * only readable via an explicit `.select('+passwordHash')` (AuthService does
 * this deliberately for login). This is defense #1; defense #2 is that no
 * controller ever returns a raw Staff document — see staff-response.mapper.ts,
 * which builds its response DTO without ever referencing this field, so even
 * an accidental `.select('+passwordHash')` elsewhere can't leak it through the
 * API. See PHASE_3_NOTES.md.
 */
@Schema({ timestamps: true, collection: 'staff' })
export class Staff {
  @Prop({ type: String, required: true, trim: true })
  firstName!: string;

  @Prop({ type: String, required: true, trim: true })
  lastName!: string;

  @Prop({ type: String, required: true, unique: true, lowercase: true, trim: true })
  email!: string;

  @Prop({ type: String, required: true, unique: true, trim: true })
  phoneNumber!: string;

  @Prop({ type: String, required: true, select: false })
  passwordHash!: string;

  @Prop({ type: String, enum: StaffRole, required: true })
  role!: StaffRole;

  @Prop({ type: Types.ObjectId, ref: 'Department', required: true })
  departmentId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Unit', required: true })
  unitId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Branch', required: true })
  branchId!: Types.ObjectId;

  @Prop({ type: [String], enum: ModuleName, required: true, default: [] })
  moduleAccess!: ModuleName[];

  @Prop({ type: String, enum: StaffStatus, required: true, default: StaffStatus.ACTIVE })
  status!: StaffStatus;

  @Prop({ type: String, default: null })
  disabledReason!: string | null;

  @Prop({ type: Types.ObjectId, ref: 'Staff', default: null })
  disabledBy!: Types.ObjectId | null;

  @Prop({ type: Date, default: null })
  disabledAt!: Date | null;

  /**
   * Phase 5 extension. Compulsory but *not* a blocker at onboarding — a
   * staff member reaches ACTIVE (Phase 3) without this. No separate
   * KycRecord-equivalent collection: staff BVN is a single live
   * `directVerify` compliance check (no OTP flow, no NIN, no biometric), so
   * a few fields directly on Staff are enough — a whole parallel collection
   * would be pure overhead. See PHASE_5_NOTES.md for the enforcement level
   * chosen (currently: visibility only, no functional block).
   */
  @Prop({ type: String, default: null })
  bvnEncrypted!: string | null;

  @Prop({ type: Boolean, required: true, default: false })
  bvnVerified!: boolean;

  @Prop({ type: Date, default: null })
  bvnVerifiedAt!: Date | null;

  @Prop({ type: Types.ObjectId, ref: 'Staff', default: null })
  bvnVerifiedBy!: Types.ObjectId | null;

  // Populated by Mongoose (schema option `timestamps: true` below), not by an
  // explicit @Prop — declared here only so TypeScript knows they exist.
  createdAt!: Date;
  updatedAt!: Date;
}

export const StaffSchema = SchemaFactory.createForClass(Staff);

StaffSchema.index({ branchId: 1, status: 1 });
StaffSchema.index({ departmentId: 1 });
StaffSchema.index({ unitId: 1 });
