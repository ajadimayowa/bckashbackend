import { BadRequestException } from '@nestjs/common';

/**
 * A structurally-valid, successfully-processed request where the provider
 * itself reports `isBvnValid: false` — per the BC Kash MFB API's own
 * integration notes: "A successful API request does not necessarily mean
 * the BVN is valid... check isBvnValid: true before treating the BVN as
 * verified." A real, expected outcome (customer mistyped their BVN), not a
 * provider/system failure — hence 400, not 503.
 */
export class BvnInvalidException extends BadRequestException {
  constructor(providerMessage?: string) {
    super(`BVN could not be verified${providerMessage ? `: ${providerMessage}` : ''}`);
  }
}
