import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

import {
  ModuleName,
  StaffEmploymentType,
  StaffRole,
  StaffStatus,
  StaffUserType,
} from '../../../common/enums/identity.enums';
import { deriveStaffUserType } from '../utils/staff-user-type.util';
import { ContactPerson, ContactPersonSchema } from './contact-person.schema';
import { Kyc, KycSchema } from './kyc.schema';
import { ResidentialAddress, ResidentialAddressSchema } from './residential-address.schema';

export type StaffDocument = HydratedDocument<Staff>;

/**
 * `userType`'s schema-level default — applied whenever a document is
 * created/hydrated without an explicit value. Exists for exactly one
 * reason: every Staff record that existed before `userType` became a real
 * (required) field has no value for it in the DB. Mongoose applies
 * `default` on hydration too (not just `new Model()`), so a legacy record
 * gets this role-derived value in memory the moment it's loaded, and it's
 * silently persisted back on that record's next `.save()` — no explicit
 * migration needed. Every *new* record is expected to supply `userType`
 * itself (see CreateStaffDirectDto/InitiateStaffOnboardingDto); this default
 * is a backward-compatibility fallback, not the primary source of the value.
 */
function defaultUserType(this: Staff): StaffUserType {
  return deriveStaffUserType(this.role);
}

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

  /**
   * Freely supplied by the caller at creation time — independent of `role`,
   * see StaffUserType's own doc comment (identity.enums.ts) for why the two
   * are never cross-validated. `defaultUserType` above only ever kicks in
   * for a legacy record created before this field existed.
   */
  @Prop({ type: String, enum: StaffUserType, required: true, default: defaultUserType })
  userType!: StaffUserType;

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

  /**
   * True for every staff record created with a system-generated temporary
   * password (both onboarding-approval and SuperAdmin direct creation —
   * see StaffService) — the welcome email tells them to change it before
   * doing anything else. Flipped to `false` by `StaffService.changePassword`.
   * Not currently enforced as a functional block (no guard rejects requests
   * from a staff member who hasn't changed it yet) — visibility only, same
   * enforcement-level choice as `bvnVerified`. The seeded SuperAdmin (a
   * real, operator-chosen password from day one, not a system-generated
   * one) is the one exception and starts `false` — see super-admin.seeder.ts.
   */
  @Prop({ type: Boolean, required: true, default: true })
  mustChangePassword!: boolean;

  /**
   * Onboarding-form fields (see StaffOnboarding.tsx) with nowhere to live
   * before this — added as sub-documents rather than flat fields per
   * field-group ("nok", "kyc", "reference"). Same "compulsory but not a
   * blocker" enforcement level as `bvn*` above: `InitiateStaffOnboardingDto`
   * and `CreateStaffDirectDto` require all of it for every *new* onboarding
   * submission, but it stays optional/nullable here at the schema level so
   * it doesn't retroactively break any Staff document created before these
   * fields existed (fixtures, seeded accounts, older records).
   */
  @Prop({ type: ResidentialAddressSchema, default: null })
  residentialAddress!: ResidentialAddress | null;

  @Prop({ type: KycSchema, default: null })
  kyc!: Kyc | null;

  @Prop({ type: ContactPersonSchema, default: null })
  nextOfKin!: ContactPerson | null;

  @Prop({ type: ContactPersonSchema, default: null })
  reference!: ContactPerson | null;

  /** Employment start date — distinct from `createdAt` (when the record was created, which may lag an approval workflow). */
  @Prop({ type: Date, default: null })
  startDate!: Date | null;

  /**
   * Public URLs under the `/uploads` static mount (see common/upload/
   * upload.config.ts, main.ts) — set at onboard/direct-create time if the
   * caller sent the corresponding multipart field, and replaceable
   * afterward via PATCH /staff/:id/documents. Same "not a blocker" level as
   * bvn/kyc above — both stay null if never supplied.
   */
  @Prop({ type: String, default: null })
  passportPhotoUrl!: string | null;

  @Prop({ type: String, default: null })
  idDocumentUrl!: string | null;

  /**
   * HR-facing fields an org:manage admin sets/edits after a staff member
   * already exists (see UpdateStaffProfileDto/StaffService.updateProfile) —
   * nothing at onboarding time collects these, so every one of them starts
   * `null`/`false` and stays that way until an admin fills it in.
   */
  @Prop({ type: String, enum: StaffEmploymentType, default: null })
  employmentType!: StaffEmploymentType | null;

  @Prop({ type: String, default: null, trim: true })
  salaryGrade!: string | null;

  /** Who this staff member reports to — independent of the org-structure hierarchy (department/unit/branch). */
  @Prop({ type: Types.ObjectId, ref: 'Staff', default: null })
  managerId!: Types.ObjectId | null;

  /** Set on every successful OTP verification — see AuthService.verifyLoginOtp. */
  @Prop({ type: Date, default: null })
  lastLoginAt!: Date | null;

  /**
   * Manual admin sign-off, not a live-verified check like `bvnVerified` —
   * there's no provider integration for these, just "has someone confirmed
   * the paperwork is in." See StaffService.updateCompliance.
   */
  @Prop({ type: Boolean, required: true, default: false })
  ninVerified!: boolean;

  @Prop({ type: Boolean, required: true, default: false })
  guarantorFormVerified!: boolean;

  @Prop({ type: Boolean, required: true, default: false })
  offerLetterVerified!: boolean;

  // Populated by Mongoose (schema option `timestamps: true` below), not by an
  // explicit @Prop — declared here only so TypeScript knows they exist.
  createdAt!: Date;
  updatedAt!: Date;
}

export const StaffSchema = SchemaFactory.createForClass(Staff);

StaffSchema.index({ branchId: 1, status: 1 });
StaffSchema.index({ departmentId: 1 });
StaffSchema.index({ unitId: 1 });
