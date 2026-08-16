import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';

import '../interfaces/staff-context.interface';

/**
 * Pulls the `ResolvedStaffContext` StaffContextGuard already attached to the
 * request — controllers should use this instead of reaching into `@Req()`
 * themselves. Only meaningful downstream of `@UseGuards(JwtAuthGuard, StaffContextGuard, ...)`.
 */
export const CurrentStaffContext = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest<Request>();
  return request.staffContext;
});
