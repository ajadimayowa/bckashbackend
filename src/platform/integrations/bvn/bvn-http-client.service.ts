import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { BvnConfig } from '../../../common/config/configuration';
import type { BvnAuthHeaders } from './bvn-provider-auth.service';
import { BvnProviderAuthService } from './bvn-provider-auth.service';
import { BvnProviderUnavailableException } from './exceptions/bvn-provider-unavailable.exception';

export interface BvnHttpResponse<T> {
  status: number;
  body: T;
}

const UNAUTHORIZED_STATUSES = [401, 403];

/** `AbortSignal.timeout()` rejects with a DOMException named "TimeoutError" (Node 18+/undici). */
function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'TimeoutError';
}

/**
 * Shared client for all three BVN endpoints — attaches auth headers via
 * BvnProviderAuthService and don't-repeat-yourself's the "retry once after a
 * transparent re-authentication" rule, so individual adapter methods never
 * touch auth directly.
 */
@Injectable()
export class BvnHttpClient {
  constructor(
    private readonly configService: ConfigService,
    private readonly authService: BvnProviderAuthService,
  ) {}

  /**
   * `retryOnUnauthorized` defaults to true (auto re-auth + retry once on
   * 401/403 — our session token expired or was rejected). Pass `false` for
   * `verify-user-kyc-consent` specifically: on that one confirmed endpoint,
   * 401 has an overloaded, *business* meaning ("OTP didn't match" — see the
   * source controller this contract was confirmed against), not "your
   * session expired," so auto-retrying there would waste a billable call
   * repeating the same wrong OTP. See PHASE_5_NOTES.md.
   */
  async post<T>(
    path: string,
    body: unknown,
    options: { retryOnUnauthorized?: boolean } = {},
  ): Promise<BvnHttpResponse<T>> {
    const bvnConfig = this.configService.get<BvnConfig>('bvn');
    const baseUrl = (bvnConfig?.baseUrl ?? '').replace(/\/+$/, '');
    const url = `${baseUrl}${path}`;
    const retryOnUnauthorized = options.retryOnUnauthorized ?? true;

    const first = await this.send<T>(url, body, await this.authService.getAuthHeaders());
    if (!retryOnUnauthorized || !UNAUTHORIZED_STATUSES.includes(first.status)) {
      return first;
    }

    // Token expired/rejected mid-flow — re-authenticate transparently and
    // retry once, rather than surfacing an error that would force the
    // customer to restart BVN consent just because our internal session expired.
    const refreshedHeaders = await this.authService.refresh();
    return this.send<T>(url, body, refreshedHeaders);
  }

  private async send<T>(
    url: string,
    body: unknown,
    authHeaders: BvnAuthHeaders,
  ): Promise<BvnHttpResponse<T>> {
    const timeoutMs = this.configService.get<BvnConfig>('bvn')?.requestTimeoutMs ?? 10000;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify(body),
        // Unbounded otherwise — the provider has no documented SLA and has
        // been observed taking 10s+ per call, which can stall the whole
        // verification request past any caller's own timeout.
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const message = isAbortError(err) ? `timed out after ${timeoutMs}ms` : (err as Error).message;
      throw new BvnProviderUnavailableException(url, message);
    }

    let parsed: T;
    try {
      parsed = (await response.json()) as T;
    } catch {
      throw new BvnProviderUnavailableException(url, 'malformed response body');
    }

    return { status: response.status, body: parsed };
  }
}
