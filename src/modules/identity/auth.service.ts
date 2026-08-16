import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import ms from 'ms';

import { StaffStatus } from '../../common/enums/identity.enums';
import type { JwtConfig } from '../../common/config/configuration';
import { AuthTokens, JwtPayload } from './interfaces/jwt-payload.interface';
import { RefreshTokenService } from './refresh-token.service';
import { StaffDocument } from './schemas/staff.schema';
import { StaffService } from './staff.service';

@Injectable()
export class AuthService {
  private readonly refreshTtlSeconds: number;

  constructor(
    private readonly staffService: StaffService,
    private readonly refreshTokenService: RefreshTokenService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {
    const jwtConfig = this.configService.get<JwtConfig>('jwt');
    // `ms` returns milliseconds for a duration string like '7d' — convert once
    // at construction. The config value is a plain `string` (validated by Joi
    // at boot, see env.validation.ts) rather than `ms`'s branded `StringValue`
    // literal type, hence the cast.
    this.refreshTtlSeconds = Math.floor(
      ms((jwtConfig?.refreshExpiresIn ?? '7d') as ms.StringValue) / 1000,
    );
  }

  private signAccessToken(staff: Pick<StaffDocument, '_id' | 'role' | 'branchId'>): string {
    const payload: JwtPayload = {
      sub: staff._id.toString(),
      role: staff.role,
      branchId: staff.branchId.toString(),
    };
    return this.jwtService.sign(payload);
  }

  async login(email: string, password: string): Promise<AuthTokens> {
    const staff = await this.staffService.findByEmailWithPassword(email);
    // Same generic message whether the email doesn't exist or the password is
    // wrong — don't let login responses be used to enumerate valid accounts.
    if (!staff) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const passwordMatches = await bcrypt.compare(password, staff.passwordHash);
    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid email or password');
    }

    // Distinct from the above — status is a real, intentional signal, not a
    // credential check. A disabled/pending account fails here even with the
    // correct password.
    if (staff.status !== StaffStatus.ACTIVE) {
      throw new UnauthorizedException(`Account is not active (status: ${staff.status})`);
    }

    const accessToken = this.signAccessToken(staff);
    const { token: refreshToken } = await this.refreshTokenService.issue(
      staff._id.toString(),
      this.refreshTtlSeconds,
    );

    return { accessToken, refreshToken };
  }

  /** Rotates the refresh token on every use — the old one is revoked, a new one issued. */
  async refresh(refreshToken: string): Promise<AuthTokens> {
    const record = await this.refreshTokenService.findActive(refreshToken);
    if (!record) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const staff = await this.staffService.findById(record.staffId.toString()).catch(() => null);
    if (!staff || staff.status !== StaffStatus.ACTIVE) {
      throw new UnauthorizedException('Account is not active');
    }

    await this.refreshTokenService.revoke(refreshToken);
    const { token: newRefreshToken } = await this.refreshTokenService.issue(
      staff._id.toString(),
      this.refreshTtlSeconds,
    );

    return { accessToken: this.signAccessToken(staff), refreshToken: newRefreshToken };
  }

  /** Idempotent — revoking an already-revoked/unknown token is not an error. */
  async logout(refreshToken: string): Promise<void> {
    await this.refreshTokenService.revoke(refreshToken);
  }
}
