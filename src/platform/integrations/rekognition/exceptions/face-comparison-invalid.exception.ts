import { BadRequestException } from '@nestjs/common';

/**
 * Rekognition successfully processed the request but rejected the input
 * itself — most commonly `InvalidParameterException` because no face (or no
 * comparable pair of faces) could be detected in one of the two images. A
 * real, expected outcome of a bad capture (poor lighting, no face in frame,
 * corrupt/unsupported image), not a provider/network failure — hence 400,
 * not 503. Mirrors BvnInvalidException's split from BvnProviderUnavailableException.
 */
export class FaceComparisonInvalidException extends BadRequestException {
  constructor(providerMessage?: string) {
    super(
      `Face comparison could not be completed — no face was detected in one of the images${
        providerMessage ? `: ${providerMessage}` : ''
      }`,
    );
  }
}
