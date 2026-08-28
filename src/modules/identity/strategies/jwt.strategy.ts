import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

import type { JwtConfig } from '../../../common/config/configuration';
import { StaffStatus } from '../../../common/enums/identity.enums';
import type { AuthenticatedStaffPrincipal } from '../../../platform/rbac/interfaces/staff-context.interface';
import { JwtPayload } from '../interfaces/jwt-payload.interface';
import { StaffService } from '../staff.service';

/**
 * `validate()` is the "short-lived access token + live status check" half of
 * the token-invalidation-on-disable mechanism (see PHASE_3_NOTES.md) — every
 * authenticated request does one lightweight DB read here to confirm the
 * token's owner is still ACTIVE, so a disable takes effect on the very next
 * request even if the access token itself hasn't expired yet. That same
 * read now also returns `userType` (Initiator/Authorizer RBAC — see
 * StaffUserType's own doc comment), live for the same reason: a userType
 * change should take effect on the very next request too, not wait out the
 * access token's lifetime the way `role`/`branchId` (still trusted as-issued
 * from the JWT payload) do.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private readonly staffService: StaffService,
  ) {
    const jwtConfig = configService.get<JwtConfig>('jwt');
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: jwtConfig?.accessSecret ?? '',
    });
  }

  async validate(payload: JwtPayload): Promise<AuthenticatedStaffPrincipal> {
    const current = await this.staffService.getStatusAndUserType(payload.sub);
    if (!current || current.status !== StaffStatus.ACTIVE) {
      throw new UnauthorizedException('Account is not active');
    }

    return {
      staffId: payload.sub,
      role: payload.role,
      branchId: payload.branchId,
      userType: current.userType,
    };
  }
}
