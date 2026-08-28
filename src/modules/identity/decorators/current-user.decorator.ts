import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';

import { AuthenticatedStaffPrincipal } from '../../../platform/rbac/interfaces/staff-context.interface';

/**
 * Pulls the bare `request.user` JwtStrategy attaches (staffId/role/branchId)
 * — for routes that only need "who is this" and don't need the full RBAC
 * capability resolution `@CurrentStaffContext()` provides (which requires
 * `StaffContextGuard` in the guard chain too). Only meaningful downstream of
 * `@UseGuards(JwtAuthGuard)`.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedStaffPrincipal => {
    const request = ctx.switchToHttp().getRequest<Request>();
    return request.user as AuthenticatedStaffPrincipal;
  },
);
