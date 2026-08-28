/**
 * What POST /staff/verify-bvn-preview returns — the provider's resolved
 * identity for a BVN, so an onboarder can confirm it against what was typed
 * into the onboarding form before ever submitting it. Never persisted —
 * there's no Staff record yet at this point (see StaffController's own doc
 * comment on the endpoint).
 */
export class BvnPreviewResponseDto {
  bvn!: string;
  firstName!: string;
  lastName!: string;
  otherNames?: string;
  dateOfBirth!: string;
  phoneNumber!: string;
}
