import { createHash, randomInt } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import type { AuthOtpConfig } from '../../common/config/configuration';
import { LOGIN_OTP_ISSUED_EVENT, LoginOtpIssuedEvent } from './events/auth-otp.events';
import { OtpExpiredException } from './exceptions/otp-expired.exception';
import { OtpInvalidException } from './exceptions/otp-invalid.exception';
import { OtpMaxAttemptsExceededException } from './exceptions/otp-max-attempts-exceeded.exception';
import { LoginOtpChallenge, LoginOtpChallengeDocument } from './schemas/login-otp-challenge.schema';
import { StaffDocument } from './schemas/staff.schema';

export interface IssuedLoginChallenge {
  challengeId: string;
  expiresAt: Date;
}

/**
 * The OTP half of the two-step login flow (email+password, then OTP —
 * see AuthService). Deliberately dispatches via `STAFF_CREATED_EVENT`'s
 * sibling event rather than calling `NotificationService`/`NOTIFICATION_PORT`
 * directly, for the same "no import cycle back into IdentityModule" reason
 * — see auth-otp.events.ts.
 */
@Injectable()
export class AuthOtpService {
  private readonly otpConfig: AuthOtpConfig;

  constructor(
    @InjectModel(LoginOtpChallenge.name)
    private readonly challengeModel: Model<LoginOtpChallengeDocument>,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.otpConfig = this.configService.get<AuthOtpConfig>('authOtp') ?? {
      ttlSeconds: 600,
      maxAttempts: 5,
    };
  }

  private hash(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }

  /**
   * `AUTH_OTP_DEFAULT_CODE`, when set, is used verbatim instead of a random
   * one — see env.validation.ts's warning comment (dev/QA only).
   */
  private generateCode(): string {
    if (this.otpConfig.defaultCode) {
      return this.otpConfig.defaultCode;
    }
    return randomInt(0, 1_000_000).toString().padStart(6, '0');
  }

  async issueChallenge(staff: StaffDocument): Promise<IssuedLoginChallenge> {
    const code = this.generateCode();
    const expiresAt = new Date(Date.now() + this.otpConfig.ttlSeconds * 1000);

    const challenge = await this.challengeModel.create({
      staffId: staff._id,
      codeHash: this.hash(code),
      attemptCount: 0,
      expiresAt,
      consumedAt: null,
    });

    const event: LoginOtpIssuedEvent = {
      staffId: staff._id.toString(),
      firstName: staff.firstName,
      email: staff.email,
      phoneNumber: staff.phoneNumber,
      code,
      expiresAt,
    };
    this.eventEmitter.emit(LOGIN_OTP_ISSUED_EVENT, event);

    return { challengeId: challenge._id.toString(), expiresAt };
  }

  /** Returns the verified challenge's staffId, or throws. Single-use — consumed on success. */
  async verifyChallenge(challengeId: string, code: string): Promise<string> {
    const challenge = await this.challengeModel.findById(challengeId).exec();
    if (!challenge || challenge.consumedAt) {
      // Same treatment as "wrong code" — an unknown/already-used challenge id
      // shouldn't let a caller distinguish "never existed" from "already used".
      throw new OtpInvalidException();
    }

    if (challenge.expiresAt.getTime() < Date.now()) {
      throw new OtpExpiredException();
    }

    if (challenge.attemptCount >= this.otpConfig.maxAttempts) {
      throw new OtpMaxAttemptsExceededException();
    }

    if (challenge.codeHash !== this.hash(code)) {
      challenge.attemptCount += 1;
      await challenge.save();
      if (challenge.attemptCount >= this.otpConfig.maxAttempts) {
        throw new OtpMaxAttemptsExceededException();
      }
      throw new OtpInvalidException();
    }

    challenge.consumedAt = new Date();
    await challenge.save();

    return challenge.staffId.toString();
  }
}
