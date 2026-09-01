import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import ms from 'ms';

import { StaffStatus } from '../../common/enums/identity.enums';
import type { JwtConfig } from '../../common/config/configuration';
import { BvnProviderAuthService } from '../../platform/integrations/bvn/bvn-provider-auth.service';
import { AuthOtpService } from './auth-otp.service';
import {
  AuthTokens,
  JwtPayload,
  LoginChallengeResponse,
  LoginResult,
} from './interfaces/jwt-payload.interface';
import { RefreshTokenService } from './refresh-token.service';
import { StaffDocument } from './schemas/staff.schema';
import { StaffService } from './staff.service';

/**
 * *** TWO-STEP LOGIN — see AUTH_OTP_* config, AuthOtpService ***
 * `login()` no longer returns tokens directly — a correct email/password
 * now only earns a `LoginOtpChallenge` (OTP sent to the staff member's
 * email and phone). `verifyLoginOtp()` is the only path that actually
 * issues an access/refresh token pair, mirroring exactly what `login()`
 * itself used to do at its tail end.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly refreshTtlSeconds: number;

  constructor(
    private readonly staffService: StaffService,
    private readonly refreshTokenService: RefreshTokenService,
    private readonly authOtpService: AuthOtpService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly bvnProviderAuthService: BvnProviderAuthService,
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

  private async issueTokens(staff: StaffDocument): Promise<AuthTokens> {
    const accessToken = this.signAccessToken(staff);
    const { token: refreshToken } = await this.refreshTokenService.issue(
      staff._id.toString(),
      this.refreshTtlSeconds,
    );
    return { accessToken, refreshToken };
  }
  async login(email: string, password: string): Promise<LoginChallengeResponse> {
    const staff = await this.staffService.findByEmailWithPassword(email);
    if (!staff) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const passwordMatches = await bcrypt.compare(password, staff.passwordHash);
    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid email or password');
    }

    if (staff.status !== StaffStatus.ACTIVE) {
      throw new UnauthorizedException(`Account is not active (status: ${staff.status})`);
    }

    const { challengeId, expiresAt } = await this.authOtpService.issueChallenge(staff);

    return {
      challengeId,
      expiresAt,
      message: 'An OTP has been sent to your registered email and phone number.',
    };
  }

  /**
   * The only path that actually issues tokens — a verified OTP challenge,
   * staffId included. `userDetails` on the response is purely a frontend
   * convenience (routing to the right protected area post-login) — the
   * access token itself remains the actual authorization artifact; nothing
   * server-side trusts `userDetails`.
   */
  async verifyLoginOtp(challengeId: string, code: string): Promise<LoginResult> {
    const staffId = await this.authOtpService.verifyChallenge(challengeId, code);

    const staff = await this.staffService.findById(staffId);
    // Defensive — status could theoretically change in the (short) window
    // between OTP issuance and verification (e.g. an Admin disables the
    // account mid-flow). Re-checked here for the same reason `refresh()`
    // re-checks it below.
    if (staff.status !== StaffStatus.ACTIVE) {
      throw new UnauthorizedException(`Account is not active (status: ${staff.status})`);
    }

    const tokens = await this.issueTokens(staff);

    // Pre-warm the BVN provider session on every successful login rather than
    // waiting for the first actual BVN call (verifyBvn/verifyBvnPreview) to
    // pay that login round-trip — cheap no-op if a still-cached session
    // exists already (see BvnProviderAuthService.getAuthHeaders). Fire-and-
    // forget: a BVN provider outage must never fail or delay a login.
    this.bvnProviderAuthService.getAuthHeaders().catch((error: unknown) => {
      this.logger.warn(
        `BVN provider pre-warm failed (non-fatal, will retry lazily on next BVN call): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });

    // Best-effort — see StaffService.recordLogin. A failure here must never
    // fail or delay the login itself.
    this.staffService.recordLogin(staffId).catch((error: unknown) => {
      this.logger.warn(
        `Failed to record lastLoginAt (non-fatal): ${error instanceof Error ? error.message : String(error)}`,
      );
    });

    return {
      ...tokens,
      userDetails: {
        id:staff._id,
        firstName: staff.firstName,
        lastName: staff.lastName,
        userType: staff.userType,
        userLevel: staff.role,
        mustChangePassword: staff.mustChangePassword,
      },
    };
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
