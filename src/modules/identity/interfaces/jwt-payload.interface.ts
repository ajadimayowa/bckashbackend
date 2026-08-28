import { StaffRole, StaffUserType } from '../../../common/enums/identity.enums';
import { Types } from 'mongoose';

/**
 * Access token claims. `role`/`branchId` are trusted as-issued for the token's
 * lifetime — only `status` is re-checked live on every request (by
 * JwtStrategy, via a DB lookup). A role/branch change therefore takes up to
 * one access-token lifetime (JWT_ACCESS_EXPIRES_IN, e.g. 4h) to take
 * effect. See PHASE_3_NOTES.md.
 */
export interface JwtPayload {
  sub: string; // staffId
  role: StaffRole;
  branchId: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

/**
 * What `POST /auth/login` now returns instead of tokens — see AuthService's
 * own doc comment. `challengeId` is opaque to the client (a LoginOtpChallenge
 * id), passed straight back to `POST /auth/login/verify-otp` along with the
 * code the staff member received by email/SMS.
 */
export interface LoginChallengeResponse {
  challengeId: string;
  expiresAt: Date;
  message: string;
}

/**
 * `userType` is the Initiator/Reviewer/Authorizer label supplied at
 * creation time (see StaffUserType's own doc comment) — display-only,
 * independent of `role`. `userLevel` is the actual `StaffRole` — the
 * frontend's own name for "which role tier this is", used to route the
 * staff member to their designated protected routes/dashboard after login.
 * `mustChangePassword` is Staff.mustChangePassword, carried here so the
 * frontend can force a POST /auth/change-password prompt right after OTP
 * verification without a second round-trip — every new staff member starts
 * with a system-generated temporary password (see StaffController).
 */
export interface AuthenticatedUserDetails {
  id:Types.ObjectId;
  firstName: string;
  lastName: string;
  userType: StaffUserType;
  userLevel: StaffRole;
  mustChangePassword: boolean;
}

/** What `POST /auth/login/verify-otp` returns — tokens plus enough identity for the frontend to route without a second round-trip. */
export interface LoginResult extends AuthTokens {
  userDetails: AuthenticatedUserDetails;
}
