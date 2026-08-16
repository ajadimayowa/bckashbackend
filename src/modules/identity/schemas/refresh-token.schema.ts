import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type RefreshTokenDocument = HydratedDocument<RefreshToken>;

/**
 * The raw refresh token is never stored — only a SHA-256 hash of it (see
 * AuthService). Long-lived (days, per JWT_REFRESH_EXPIRES_IN), so unlike the
 * short-lived access token this needs server-side revocation: on logout, and
 * — critically — on staff disable (StaffService.disable revokes every
 * outstanding refresh token for that staff so a disabled account can't mint a
 * fresh access token even though its old one might still be technically
 * unexpired for a few more minutes).
 */
@Schema({ timestamps: true, collection: 'refresh_tokens' })
export class RefreshToken {
  @Prop({ type: Types.ObjectId, ref: 'Staff', required: true })
  staffId!: Types.ObjectId;

  @Prop({ type: String, required: true, unique: true })
  tokenHash!: string;

  @Prop({ type: Date, required: true })
  expiresAt!: Date;

  @Prop({ type: Date, default: null })
  revokedAt!: Date | null;
}

export const RefreshTokenSchema = SchemaFactory.createForClass(RefreshToken);

RefreshTokenSchema.index({ staffId: 1, revokedAt: 1 });
// TTL index — Mongo garbage-collects expired token records automatically
// instead of this collection growing forever.
RefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
