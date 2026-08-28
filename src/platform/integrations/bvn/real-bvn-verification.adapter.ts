import { Injectable } from '@nestjs/common';

import { BvnCallLogService } from './bvn-call-log.service';
import { BvnHttpClient } from './bvn-http-client.service';
import { BvnCallEntityType, BvnCallStep } from './enums/bvn-call-log.enums';
import { BvnInvalidException } from './exceptions/bvn-invalid.exception';
import { BvnProviderUnavailableException } from './exceptions/bvn-provider-unavailable.exception';
import {
  BvnCallContext,
  BvnDetails,
  BvnVerificationAdapter,
} from './interfaces/bvn-verification-adapter.interface';

/** The real BC Kash MFB `POST /identity/get_bvn` response shape — see "BC Kash MFB API Integration Documentation". Field casing (BVN/FirstName/LastName/OtherNames/DOB) is the provider's own, not ours. */
interface GetBvnResponseBody {
  RequestStatus?: boolean;
  ResponseMessage?: string;
  isBvnValid?: boolean;
  bvnDetails?: {
    BVN?: string;
    phoneNumber?: string;
    FirstName?: string;
    LastName?: string;
    OtherNames?: string;
    DOB?: string;
  };
}

@Injectable()
export class RealBvnVerificationAdapter implements BvnVerificationAdapter {
  constructor(
    private readonly httpClient: BvnHttpClient,
    private readonly callLogService: BvnCallLogService,
  ) {}

  /**
   * The provider's own single BVN endpoint. Its own integration notes are
   * explicit: "A successful API request does not necessarily mean the BVN
   * is valid... check isBvnValid: true before treating the BVN as
   * verified" — so `RequestStatus: true` + `isBvnValid: false` is a real,
   * distinct outcome (BvnInvalidException, 400) from a provider/network
   * failure (BvnProviderUnavailableException, 503).
   */
  async directVerify(bvn: string, context?: BvnCallContext): Promise<BvnDetails> {
    const { status, body } = await this.httpClient.post<GetBvnResponseBody>('/identity/get_bvn', {
      bvn,
    });

    const requestOk = status >= 200 && status < 300 && body?.RequestStatus === true;
    if (!requestOk) {
      await this.log(bvn, false, status, body?.ResponseMessage ?? null, context);
      throw new BvnProviderUnavailableException(
        'direct verification',
        `HTTP ${status}${body?.ResponseMessage ? ` — ${body.ResponseMessage}` : ''}`,
      );
    }

    const details = body.bvnDetails;
    if (body?.isBvnValid !== true || !details?.BVN) {
      await this.log(bvn, false, status, body?.ResponseMessage ?? 'isBvnValid: false', context);
      throw new BvnInvalidException(body?.ResponseMessage);
    }

    await this.log(bvn, true, status, null, context);

    return {
      bvn: details.BVN,
      firstName: details.FirstName ?? '',
      lastName: details.LastName ?? '',
      otherNames: details.OtherNames || undefined,
      dateOfBirth: details.DOB ?? '',
      phoneNumber: details.phoneNumber ?? '',
      rawResponse: body as unknown as Record<string, unknown>,
    };
  }

  private async log(
    bvn: string | null,
    success: boolean,
    providerStatusCode: number | null,
    errorMessage: string | null,
    context?: BvnCallContext,
  ): Promise<void> {
    await this.callLogService.record({
      step: BvnCallStep.DIRECT_VERIFY,
      bvn,
      success,
      providerStatusCode,
      errorMessage,
      calledBy: context?.calledBy ?? null,
      calledForEntityType: (context?.entityType as BvnCallEntityType | undefined) ?? null,
      calledForEntityId: context?.entityId ?? null,
    });
  }
}
