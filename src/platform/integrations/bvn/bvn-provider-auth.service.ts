import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { BvnConfig } from '../../../common/config/configuration';
import { BvnCallLogService } from './bvn-call-log.service';
import { BvnCallStep } from './enums/bvn-call-log.enums';
import { BvnProviderUnavailableException } from './exceptions/bvn-provider-unavailable.exception';

export interface BvnAuthHeaders {
  'X-Auth-Signature': string;
  Authorization: string;
}

interface BvnLoginResponseBody {
  error?: boolean;
  message?: string;
  Authorisation?: {
    auth?: string;
    accesscode?: string;
    uid?: string;
    Businessname?: string;
  };
}

/**
 * Confirmed against the existing internal codebase this provider contract
 * comes from (see PHASE_5_NOTES.md) — login is `POST {baseUrl}/initialisation/init`
 * with `{ Email, Password }` (capitalized keys, matching the provider's own
 * casing), returning `{ Authorisation: { auth, accesscode } }`. Every
 * subsequent call attaches *two* headers derived from that response:
 * `X-Auth-Signature: {auth}` and `Authorization: Bearer {accesscode}` — not
 * a single bearer token as a first read of the brief might suggest. Cached
 * until a 401/403 forces re-authentication (the provider's login response
 * doesn't carry an expiry to track proactively).
 */
@Injectable()
export class BvnProviderAuthService {
  private readonly logger = new Logger(BvnProviderAuthService.name);
  private cachedHeaders: BvnAuthHeaders | null = null;
  private pendingLogin: Promise<BvnAuthHeaders> | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly bvnCallLogService: BvnCallLogService,
  ) {}

  async getAuthHeaders(forceRefresh = false): Promise<BvnAuthHeaders> {
    if (!forceRefresh && this.cachedHeaders) {
      return this.cachedHeaders;
    }
    return this.login();
  }

  /** Called by the HTTP client on a 401/403 — clears the cache and logs in again. */
  async refresh(): Promise<BvnAuthHeaders> {
    this.cachedHeaders = null;
    return this.login();
  }

  private async login(): Promise<BvnAuthHeaders> {
    // Coalesce concurrent callers into a single login request rather than
    // each firing their own — mirrors the source pattern's `pendingLogin`.
    if (this.pendingLogin) {
      return this.pendingLogin;
    }

    this.pendingLogin = this.doLogin().finally(() => {
      this.pendingLogin = null;
    });
    return this.pendingLogin;
  }

  private async doLogin(): Promise<BvnAuthHeaders> {
    const bvnConfig = this.configService.get<BvnConfig>('bvn');
    const baseUrl = (bvnConfig?.baseUrl ?? '').replace(/\/+$/, '');
    const email = bvnConfig?.authEmail;
    const password = bvnConfig?.authPassword;

    if (!email || !password) {
      throw new BvnProviderUnavailableException(
        'authentication',
        'BVN_QUERY_AUTH_EMAIL / BVN_QUERY_AUTH_PASSWORD are not configured',
      );
    }

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/initialisation/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ Email: email, Password: password }),
      });
    } catch (err) {
      await this.logCall(false, null, `network error: ${(err as Error).message}`);
      throw new BvnProviderUnavailableException('authentication', (err as Error).message);
    }

    let body: BvnLoginResponseBody;
    try {
      body = (await response.json()) as BvnLoginResponseBody;
    } catch {
      await this.logCall(false, response.status, 'malformed login response body');
      throw new BvnProviderUnavailableException('authentication', 'malformed response body');
    }

    const auth = body.Authorisation?.auth;
    const accesscode = body.Authorisation?.accesscode;

    if (!response.ok || body.error || !auth || !accesscode) {
      await this.logCall(false, response.status, body.message ?? 'login rejected');
      throw new BvnProviderUnavailableException('authentication', body.message);
    }

    await this.logCall(true, response.status, null);

    this.cachedHeaders = { 'X-Auth-Signature': auth, Authorization: `Bearer ${accesscode}` };
    this.logger.log('BVN provider session established');
    return this.cachedHeaders;
  }

  private async logCall(
    success: boolean,
    providerStatusCode: number | null,
    errorMessage: string | null,
  ): Promise<void> {
    await this.bvnCallLogService.record({
      step: BvnCallStep.AUTH_LOGIN,
      success,
      providerStatusCode,
      errorMessage,
    });
  }
}
