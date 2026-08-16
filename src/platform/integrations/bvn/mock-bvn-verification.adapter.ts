import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { BvnCallLogService } from './bvn-call-log.service';
import { BvnCallEntityType, BvnCallStep } from './enums/bvn-call-log.enums';
import { BvnConsentExpiredException } from './exceptions/bvn-consent-expired.exception';
import { BvnOtpInvalidException } from './exceptions/bvn-otp-invalid.exception';
import {
  BvnCallContext,
  BvnConsentInitiation,
  BvnDetails,
  BvnVerificationAdapter,
} from './interfaces/bvn-verification-adapter.interface';

/** Always the "correct" OTP in the mock — any other value simulates a mismatch. */
export const MOCK_BVN_OTP = '000000';
const CONSENT_TTL_MS = 10 * 60_000;

interface PendingMockConsent {
  bvn: string;
  details: BvnDetails;
  expiresAt: number;
}

/**
 * Deterministic, in-memory stand-in — no live calls, selected via config
 * (see bvn.module.ts) when BVN_QUERY_AUTH_EMAIL/PASSWORD aren't set or
 * BVN_QUERY_USE_MOCK=true. Still writes real BvnCallLog entries, so tests
 * exercising the call-logging requirement work against this adapter too.
 */
@Injectable()
export class MockBvnVerificationAdapter implements BvnVerificationAdapter {
  private readonly pending = new Map<string, PendingMockConsent>();

  constructor(private readonly callLogService: BvnCallLogService) {}

  private buildDetails(bvn: string): BvnDetails {
    return {
      bvn,
      firstName: 'Mock',
      lastName: 'Customer',
      otherNames: undefined,
      dateOfBirth: '1990-01-01',
      phoneNumber: `080${bvn.slice(-8).padStart(8, '0')}`,
      rawResponse: { mock: true, bvn },
    };
  }

  async initiateConsent(bvn: string, context?: BvnCallContext): Promise<BvnConsentInitiation> {
    const details = this.buildDetails(bvn);
    const consentToken = `mock-consent-${randomUUID()}`;
    const expiresAt = Date.now() + CONSENT_TTL_MS;
    this.pending.set(consentToken, { bvn, details, expiresAt });

    await this.log(BvnCallStep.CONSENT_INITIATE, bvn, true, context);

    return {
      consentToken,
      otpSentToPhone: `${'*'.repeat(7)}${details.phoneNumber.slice(-4)}`,
      expiresAt: new Date(expiresAt),
    };
  }

  async confirmConsent(
    consentToken: string,
    otp: string,
    context?: BvnCallContext,
  ): Promise<BvnDetails> {
    const entry = this.pending.get(consentToken);
    if (!entry || entry.expiresAt < Date.now()) {
      this.pending.delete(consentToken);
      await this.log(BvnCallStep.CONSENT_CONFIRM, entry?.bvn ?? null, false, context);
      throw new BvnConsentExpiredException();
    }

    if (otp !== MOCK_BVN_OTP) {
      await this.log(BvnCallStep.CONSENT_CONFIRM, entry.bvn, false, context);
      throw new BvnOtpInvalidException();
    }

    this.pending.delete(consentToken); // one-time use, matching the real provider
    await this.log(BvnCallStep.CONSENT_CONFIRM, entry.bvn, true, context);
    return entry.details;
  }

  async directVerify(bvn: string, context?: BvnCallContext): Promise<BvnDetails> {
    await this.log(BvnCallStep.DIRECT_VERIFY, bvn, true, context);
    return this.buildDetails(bvn);
  }

  private async log(
    step: BvnCallStep,
    bvn: string | null,
    success: boolean,
    context?: BvnCallContext,
  ): Promise<void> {
    await this.callLogService.record({
      step,
      bvn,
      success,
      providerStatusCode: success ? 200 : 400,
      calledBy: context?.calledBy ?? null,
      calledForEntityType: (context?.entityType as BvnCallEntityType | undefined) ?? null,
      calledForEntityId: context?.entityId ?? null,
    });
  }
}
