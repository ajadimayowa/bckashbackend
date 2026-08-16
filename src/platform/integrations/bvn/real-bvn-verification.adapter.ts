import { Injectable } from '@nestjs/common';

import { BvnCallLogService } from './bvn-call-log.service';
import {
  extractMessage,
  decodeJwtExpiryMs,
  mapToBvnDetails,
  unwrapEnvelope,
} from './bvn-response.util';
import { BvnHttpClient } from './bvn-http-client.service';
import { BvnCallEntityType, BvnCallStep } from './enums/bvn-call-log.enums';
import { BvnConsentExpiredException } from './exceptions/bvn-consent-expired.exception';
import { BvnOtpInvalidException } from './exceptions/bvn-otp-invalid.exception';
import { BvnProviderUnavailableException } from './exceptions/bvn-provider-unavailable.exception';
import {
  BvnCallContext,
  BvnConsentInitiation,
  BvnDetails,
  BvnVerificationAdapter,
} from './interfaces/bvn-verification-adapter.interface';

const DEFAULT_CONSENT_TTL_MINUTES = 10;

@Injectable()
export class RealBvnVerificationAdapter implements BvnVerificationAdapter {
  constructor(
    private readonly httpClient: BvnHttpClient,
    private readonly callLogService: BvnCallLogService,
  ) {}

  async initiateConsent(bvn: string, context?: BvnCallContext): Promise<BvnConsentInitiation> {
    const { status, body } = await this.httpClient.post<Record<string, unknown>>(
      '/bvn/get-user-consent',
      { bvn },
    );
    const unwrapped = unwrapEnvelope(body);
    const consentToken = unwrapped.consentToken;

    if (status < 200 || status >= 300 || typeof consentToken !== 'string') {
      await this.log(
        BvnCallStep.CONSENT_INITIATE,
        bvn,
        false,
        status,
        extractMessage(unwrapped),
        context,
      );
      throw new BvnProviderUnavailableException('consent initiation', extractMessage(unwrapped));
    }

    await this.log(BvnCallStep.CONSENT_INITIATE, bvn, true, status, null, context);

    const expiryMs = decodeJwtExpiryMs(consentToken);
    const expiresAt = expiryMs
      ? new Date(expiryMs)
      : new Date(
          Date.now() + Number(unwrapped.expiresInMinutes ?? DEFAULT_CONSENT_TTL_MINUTES) * 60_000,
        );

    return {
      consentToken,
      otpSentToPhone: typeof unwrapped.phoneNumber === 'string' ? unwrapped.phoneNumber : '',
      expiresAt,
    };
  }

  async confirmConsent(
    consentToken: string,
    otp: string,
    context?: BvnCallContext,
  ): Promise<BvnDetails> {
    // Client-side pre-check — never even spend a provider call on a token we
    // can already tell has expired.
    const expiryMs = decodeJwtExpiryMs(consentToken);
    if (expiryMs !== null && expiryMs < Date.now()) {
      await this.log(
        BvnCallStep.CONSENT_CONFIRM,
        null,
        false,
        null,
        'consent token expired (client-side check)',
        context,
      );
      throw new BvnConsentExpiredException();
    }

    // retryOnUnauthorized: false — on this endpoint, 401 means "OTP didn't
    // match" (a business outcome), not "our session token expired". See
    // BvnHttpClient.post's doc comment and PHASE_5_NOTES.md.
    const { status, body } = await this.httpClient.post<Record<string, unknown>>(
      '/bvn/verify-user-kyc-consent',
      { consentToken, otp },
      { retryOnUnauthorized: false },
    );

    if (status === 401) {
      await this.log(BvnCallStep.CONSENT_CONFIRM, null, false, status, 'otp mismatch', context);
      throw new BvnOtpInvalidException();
    }
    if (status === 400) {
      await this.log(
        BvnCallStep.CONSENT_CONFIRM,
        null,
        false,
        status,
        'consent token invalid/expired',
        context,
      );
      throw new BvnConsentExpiredException();
    }

    const unwrapped = unwrapEnvelope(body);
    if (status < 200 || status >= 300 || !unwrapped.bvn) {
      await this.log(
        BvnCallStep.CONSENT_CONFIRM,
        null,
        false,
        status,
        extractMessage(unwrapped),
        context,
      );
      throw new BvnProviderUnavailableException('consent confirmation', extractMessage(unwrapped));
    }

    const details = mapToBvnDetails(unwrapped);
    await this.log(BvnCallStep.CONSENT_CONFIRM, details.bvn, true, status, null, context);
    return details;
  }

  async directVerify(bvn: string, context?: BvnCallContext): Promise<BvnDetails> {
    const { status, body } = await this.httpClient.post<Record<string, unknown>>('/bvn/verify', {
      bvn,
    });
    const unwrapped = unwrapEnvelope(body);

    if (status < 200 || status >= 300 || !unwrapped.bvn) {
      await this.log(
        BvnCallStep.DIRECT_VERIFY,
        bvn,
        false,
        status,
        extractMessage(unwrapped),
        context,
      );
      throw new BvnProviderUnavailableException('direct verification', extractMessage(unwrapped));
    }

    await this.log(BvnCallStep.DIRECT_VERIFY, bvn, true, status, null, context);
    return mapToBvnDetails(unwrapped);
  }

  private async log(
    step: BvnCallStep,
    bvn: string | null,
    success: boolean,
    providerStatusCode: number | null,
    errorMessage: string | null | undefined,
    context?: BvnCallContext,
  ): Promise<void> {
    await this.callLogService.record({
      step,
      bvn,
      success,
      providerStatusCode,
      errorMessage: errorMessage ?? null,
      calledBy: context?.calledBy ?? null,
      calledForEntityType: (context?.entityType as BvnCallEntityType | undefined) ?? null,
      calledForEntityId: context?.entityId ?? null,
    });
  }
}
