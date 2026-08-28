import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type LoginOtpChallengeDocument = HydratedDocument<LoginOtpChallenge>;

/**
 * The bridge between the two-step login flow's first and second requests —
 * created after a correct email/password, consumed by a correct OTP. Only
 * the SHA-256 hash of the code is ever stored (same "no offline-guessing
 * risk that would call for bcrypt" reasoning as RefreshToken's tokenHash —
 * except a 6-digit OTP genuinely *is* low-entropy, which is why this also
 * carries `attemptCount`: an online brute force is capped at
 * `AuthOtpConfig.maxAttempts` guesses before the whole challenge is
 * invalidated, not just rate-limited). TTL-indexed so an abandoned,
 * never-verified challenge cleans up automatically — same pattern as
 * PendingBvnConsent.
 */
@Schema({ timestamps: true, collection: 'login_otp_challenges' })
export class LoginOtpChallenge {
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

export const LoginOtpChallengeSchema = SchemaFactory.createForClass(LoginOtpChallenge);

LoginOtpChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
