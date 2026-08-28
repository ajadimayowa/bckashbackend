import { createHash, randomInt } from 'node:crypto';

import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { Customer, CustomerDocument } from '../customers/schemas/customer.schema';
import { ConsentCodeExpiredException } from './exceptions/consent-code-expired.exception';
import { ConsentCodeInvalidException } from './exceptions/consent-code-invalid.exception';
import { ConsentCodeMaxAttemptsExceededException } from './exceptions/consent-code-max-attempts-exceeded.exception';
import { NOTIFICATION_PORT, NotificationPort } from './interfaces/notification-port.interface';
import {
  LoanConsentChallenge,
  LoanConsentChallengeDocument,
} from './schemas/loan-consent-challenge.schema';

const TTL_SECONDS = 600; // 10 minutes — same default as AuthOtpService's login OTP
const MAX_ATTEMPTS = 5;

export interface IssuedLoanConsentChallenge {
  challengeId: string;
  expiresAt: Date;
}

/**
 * The customer-consent step of raising a loan — see LoanConsentChallenge's
 * own doc comment for the full shape/rationale (mirrors identity's
 * AuthOtpService, keyed to a Customer instead of a Staff member). Dispatch
 * goes straight through `NotificationPort` (already bound to
 * `RealNotificationPort`, same DI token LoansService itself uses) rather
 * than an event+listener indirection — LoansModule has no import-cycle
 * constraint against NotificationsModule the way IdentityModule does (see
 * that module's own event-based workaround), so there's nothing to work
 * around here.
 */
@Injectable()
export class LoanConsentService {
  constructor(
    @InjectModel(LoanConsentChallenge.name)
    private readonly challengeModel: Model<LoanConsentChallengeDocument>,
    @InjectModel(Customer.name) private readonly customerModel: Model<CustomerDocument>,
    @Inject(NOTIFICATION_PORT) private readonly notificationPort: NotificationPort,
  ) {}

  private hash(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }

  private generateCode(): string {
    return randomInt(0, 1_000_000).toString().padStart(6, '0');
  }

  async issueChallenge(
    customerId: string,
    requestedBy: string,
  ): Promise<IssuedLoanConsentChallenge> {
    const customer = await this.customerModel.findById(customerId).exec();
    if (!customer) {
      throw new NotFoundException(`Customer ${customerId} not found`);
    }

    const code = this.generateCode();
    const expiresAt = new Date(Date.now() + TTL_SECONDS * 1000);

    const challenge = await this.challengeModel.create({
      customerId,
      requestedBy,
      codeHash: this.hash(code),
      attemptCount: 0,
      expiresAt,
      consumedAt: null,
    });

    await this.notificationPort.sendLoanConsentCode(customerId, code, expiresAt);

    return { challengeId: challenge._id.toString(), expiresAt };
  }

  /**
   * Returns the verified challenge's customerId, or throws — same shape as
   * AuthOtpService.verifyChallenge. Single-use, consumed on success (a
   * second raise attempt reusing the same code, intentionally or by a
   * retried request, must request a fresh one). The caller (LoansService)
   * decides what the returned customerId must match — see its own comment.
   */
  async verifyChallenge(challengeId: string, code: string): Promise<string> {
    const challenge = await this.challengeModel.findById(challengeId).exec();
    // Same treatment as "wrong code" — an unknown/already-used challenge id
    // shouldn't let a caller distinguish "never existed" from "already used".
    if (!challenge || challenge.consumedAt) {
      throw new ConsentCodeInvalidException();
    }

    if (challenge.expiresAt.getTime() < Date.now()) {
      throw new ConsentCodeExpiredException();
    }

    if (challenge.attemptCount >= MAX_ATTEMPTS) {
      throw new ConsentCodeMaxAttemptsExceededException();
    }

    if (challenge.codeHash !== this.hash(code)) {
      challenge.attemptCount += 1;
      await challenge.save();
      if (challenge.attemptCount >= MAX_ATTEMPTS) {
        throw new ConsentCodeMaxAttemptsExceededException();
      }
      throw new ConsentCodeInvalidException();
    }

    challenge.consumedAt = new Date();
    await challenge.save();

    return challenge.customerId.toString();
  }
}
