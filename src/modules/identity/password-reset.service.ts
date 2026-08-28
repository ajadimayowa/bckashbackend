import { createHash, randomInt } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import type { PasswordResetConfig } from '../../common/config/configuration';
import { StaffStatus } from '../../common/enums/identity.enums';
import {
  PASSWORD_RESET_COMPLETED_EVENT,
  PASSWORD_RESET_REQUESTED_EVENT,
  PasswordResetCompletedEvent,
  PasswordResetRequestedEvent,
} from './events/password-reset.events';
import { OtpExpiredException } from './exceptions/otp-expired.exception';
import { OtpInvalidException } from './exceptions/otp-invalid.exception';
import { OtpMaxAttemptsExceededException } from './exceptions/otp-max-attempts-exceeded.exception';
import {
  PasswordResetChallenge,
  PasswordResetChallengeDocument,
} from './schemas/password-reset-challenge.schema';
import { StaffService } from './staff.service';

/**
 * The no-login-required "forgot password" flow — `requestReset` emails a
 * one-time code, `resetPassword` exchanges a still-valid code for a new
 * password. Deliberately keyed by *email* rather than an opaque challenge
 * id (unlike `AuthOtpService`'s login OTP): the login flow already knows
 * it has a real, just-authenticated staff member by the time it issues a
 * challenge id, but here the caller has proven nothing yet, so there's no
 * safe id to hand back that wouldn't itself reveal whether the email is
 * registered. See `requestReset`'s own doc comment.
 */
@Injectable()
export class PasswordResetService {
  private readonly config: PasswordResetConfig;

  constructor(
    @InjectModel(PasswordResetChallenge.name)
    private readonly challengeModel: Model<PasswordResetChallengeDocument>,
    private readonly staffService: StaffService,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.config = this.configService.get<PasswordResetConfig>('passwordReset') ?? {
      ttlSeconds: 600,
      maxAttempts: 5,
    };
  }

  private hash(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }

  /** `PASSWORD_RESET_DEFAULT_CODE`, when set, is used verbatim — dev/QA only, see env.validation.ts. */
  private generateCode(): string {
    if (this.config.defaultCode) {
      return this.config.defaultCode;
    }
    return randomInt(0, 1_000_000).toString().padStart(6, '0');
  }

  /**
   * Always resolves the same way (void, no error) whether or not `email`
   * matches an account, and whether or not that account is ACTIVE — the
   * same enumeration-safe posture as `AuthService.login`'s generic
   * "Invalid email or password". A non-existent or non-ACTIVE account
   * silently gets no challenge and no email; the controller returns one
   * fixed message regardless. Never throws for a bad email — the DTO's
   * `@IsEmail()` is the only validation this needs.
   */
  async requestReset(email: string): Promise<void> {
    const staff = await this.staffService.findByEmail(email);
    if (!staff || staff.status !== StaffStatus.ACTIVE) {
      return;
    }

    const code = this.generateCode();
    const expiresAt = new Date(Date.now() + this.config.ttlSeconds * 1000);

    await this.challengeModel.create({
      staffId: staff._id,
      codeHash: this.hash(code),
      attemptCount: 0,
      expiresAt,
      consumedAt: null,
    });

    const event: PasswordResetRequestedEvent = {
      staffId: staff._id.toString(),
      firstName: staff.firstName,
      email: staff.email,
      code,
      expiresAt,
    };
    this.eventEmitter.emit(PASSWORD_RESET_REQUESTED_EVENT, event);
  }

  /**
   * Verifies `code` against the most recent unconsumed challenge for
   * `email`, then sets `newPassword` — proof of possession here is the
   * emailed code, so unlike `StaffService.changePassword` there's no
   * current password to check. Same side effects as a self-service change:
   * `mustChangePassword` cleared, every outstanding refresh token revoked,
   * audited — plus a confirmation email (`PASSWORD_RESET_COMPLETED_EVENT`).
   * Throws the same generic OTP exceptions as `AuthOtpService.verifyChallenge`
   * for an unknown email/no challenge/wrong code, so a caller can't
   * distinguish "no such account" from "wrong code".
   */
  async resetPassword(email: string, code: string, newPassword: string): Promise<void> {
    const staff = await this.staffService.findByEmail(email);
    if (!staff) {
      throw new OtpInvalidException();
    }

    const challenge = await this.challengeModel
      .findOne({ staffId: staff._id, consumedAt: null })
      .sort({ createdAt: -1 })
      .exec();
    if (!challenge) {
      throw new OtpInvalidException();
    }

    if (challenge.expiresAt.getTime() < Date.now()) {
      throw new OtpExpiredException();
    }

    if (challenge.attemptCount >= this.config.maxAttempts) {
      throw new OtpMaxAttemptsExceededException();
    }

    if (challenge.codeHash !== this.hash(code)) {
      challenge.attemptCount += 1;
      await challenge.save();
      if (challenge.attemptCount >= this.config.maxAttempts) {
        throw new OtpMaxAttemptsExceededException();
      }
      throw new OtpInvalidException();
    }

    challenge.consumedAt = new Date();
    await challenge.save();

    await this.staffService.setPassword(staff._id.toString(), newPassword);

    const event: PasswordResetCompletedEvent = {
      staffId: staff._id.toString(),
      firstName: staff.firstName,
      email: staff.email,
    };
    this.eventEmitter.emit(PASSWORD_RESET_COMPLETED_EVENT, event);
  }
}
