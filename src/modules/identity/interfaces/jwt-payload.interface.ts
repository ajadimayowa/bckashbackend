import { StaffRole } from '../../../common/enums/identity.enums';

/**
 * Access token claims. `role`/`branchId` are trusted as-issued for the token's
 * lifetime — only `status` is re-checked live on every request (by
 * JwtStrategy, via a DB lookup). A role/branch change therefore takes up to
 * one access-token lifetime (JWT_ACCESS_EXPIRES_IN, e.g. 15 min) to take
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
