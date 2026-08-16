import { createHash, randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { RefreshToken, RefreshTokenDocument } from './schemas/refresh-token.schema';

export interface IssuedRefreshToken {
  token: string;
  expiresAt: Date;
}

/**
 * Only the SHA-256 hash of a refresh token ever touches the database — the raw
 * value exists solely in the response body handed to the client and is
 * unrecoverable from what's stored (unlike bcrypt, SHA-256 is deliberately
 * used here because we need a fast, deterministic lookup by hash — refresh
 * tokens are high-entropy random values, not user-chosen secrets, so there's
 * no offline-guessing risk that would call for a slow hash like bcrypt).
 */
@Injectable()
export class RefreshTokenService {
  constructor(
    @InjectModel(RefreshToken.name) private readonly refreshTokenModel: Model<RefreshTokenDocument>,
  ) {}

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  async issue(staffId: string, ttlSeconds: number): Promise<IssuedRefreshToken> {
    const token = randomBytes(64).toString('hex');
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    await this.refreshTokenModel.create({
      staffId,
      tokenHash: this.hash(token),
      expiresAt,
      revokedAt: null,
    });

    return { token, expiresAt };
  }

  /** Returns the live (unrevoked, unexpired) token record for a raw token, or null. */
  async findActive(token: string): Promise<RefreshTokenDocument | null> {
    return this.refreshTokenModel
      .findOne({ tokenHash: this.hash(token), revokedAt: null, expiresAt: { $gt: new Date() } })
      .exec();
  }

  async revoke(token: string): Promise<void> {
    await this.refreshTokenModel
      .updateOne(
        { tokenHash: this.hash(token), revokedAt: null },
        { $set: { revokedAt: new Date() } },
      )
      .exec();
  }

  /** Called on staff disable — a disabled account must not be able to mint a fresh access token. */
  async revokeAllForStaff(staffId: string): Promise<void> {
    await this.refreshTokenModel
      .updateMany({ staffId, revokedAt: null }, { $set: { revokedAt: new Date() } })
      .exec();
  }
}
