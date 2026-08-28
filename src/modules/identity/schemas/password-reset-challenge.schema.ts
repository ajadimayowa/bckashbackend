import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type PasswordResetChallengeDocument = HydratedDocument<PasswordResetChallenge>;

/**
 * The bridge between the forgot-password flow's two requests — created by
 * `POST /auth/forgot-password`, consumed by `POST /auth/reset-password`.
 * Deliberately its own collection rather than reusing `LoginOtpChallenge`:
 * the two flows are independent (a staff member could have a live login
 * OTP and a live password-reset code at the same time) even though the
 * shape and every guarantee here is identical — only the SHA-256 hash of
 * the code is ever stored, `attemptCount` caps online brute force at
 * `PasswordResetConfig.maxAttempts`, and the TTL index cleans up an
 * abandoned, never-verified challenge automatically. See
 * `login-otp-challenge.schema.ts`'s own doc comment for the full reasoning.
 */
@Schema({ timestamps: true, collection: 'password_reset_challenges' })
export class PasswordResetChallenge {
  @Prop({ type: Types.ObjectId, ref: 'Staff', required: true })
  staffId!: Types.ObjectId;

  @Prop({ type: String, required: true })
  codeHash!: string;

  @Prop({ type: Number, required: true, default: 0 })
  attemptCount!: number;

  @Prop({ type: Date, required: true })
  expiresAt!: Date;

  @Prop({ type: Date, default: null })
  consumedAt!: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const PasswordResetChallengeSchema = SchemaFactory.createForClass(PasswordResetChallenge);

PasswordResetChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
// The lookup `resetPassword` actually runs on — most recent unconsumed
// challenge for a given staff member.
PasswordResetChallengeSchema.index({ staffId: 1, consumedAt: 1, createdAt: -1 });
