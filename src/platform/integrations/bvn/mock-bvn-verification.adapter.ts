import { Injectable } from '@nestjs/common';

import { BvnCallLogService } from './bvn-call-log.service';
import { BvnCallEntityType, BvnCallStep } from './enums/bvn-call-log.enums';
import { BvnCallContext, BvnDetails, BvnVerificationAdapter } from './interfaces/bvn-verification-adapter.interface';

/**
 * Deterministic, in-memory stand-in — no live calls, selected via config
 * (see bvn.module.ts) when BVN_QUERY_AUTH_EMAIL/PASSWORD aren't set or
 * BVN_QUERY_USE_MOCK=true. Still writes real BvnCallLog entries, so tests
 * exercising the call-logging requirement work against this adapter too.
 */
@Injectable()
export class MockBvnVerificationAdapter implements BvnVerificationAdapter {
  constructor(private readonly callLogService: BvnCallLogService) {}

  async directVerify(bvn: string, context?: BvnCallContext): Promise<BvnDetails> {
    const details: BvnDetails = {
      bvn,
      firstName: 'Mock',
      lastName: 'Customer',
      otherNames: undefined,
      dateOfBirth: '1990-01-01',
      phoneNumber: `080${bvn.slice(-8).padStart(8, '0')}`,
      rawResponse: { mock: true, bvn },
    };

    await this.callLogService.record({
      step: BvnCallStep.DIRECT_VERIFY,
      bvn,
      success: true,
      providerStatusCode: 200,
      calledBy: context?.calledBy ?? null,
      calledForEntityType: (context?.entityType as BvnCallEntityType | undefined) ?? null,
      calledForEntityId: context?.entityId ?? null,
    });

    return details;
  }
}
