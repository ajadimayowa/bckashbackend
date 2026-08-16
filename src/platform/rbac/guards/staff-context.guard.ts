import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';

import '../interfaces/staff-context.interface';
import { RbacService } from '../rbac.service';

/**
 * Resolves `request.user` (populated upstream by a JWT auth guard — Phase 3's
 * job, not this module's) into a full `ResolvedStaffContext` on
 * `request.staffContext`, so CapabilityGuard/ModuleAccessGuard and downstream
 * services never re-query RBAC for the same request.
 *
 * Must run after authentication and before CapabilityGuard/ModuleAccessGuard —
 * order guards as `@UseGuards(JwtAuthGuard, StaffContextGuard, CapabilityGuard)`.
 */
@Injectable()
export class StaffContextGuard implements CanActivate {
  constructor(private readonly rbacService: RbacService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const principal = request.user;

    if (!principal?.staffId || !principal.role) {
      throw new UnauthorizedException('No authenticated staff principal on this request');
    }

    request.staffContext = await this.rbacService.resolveContext(principal);
    return true;
  }
}
