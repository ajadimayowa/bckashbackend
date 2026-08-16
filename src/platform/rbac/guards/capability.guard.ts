import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';

import '../interfaces/staff-context.interface';
import { CAPABILITY_METADATA_KEY } from '../decorators/require-capability.decorator';

/**
 * Checks the `@RequireCapability(...)` dimension only. Must run after
 * StaffContextGuard (needs `request.staffContext` already populated).
 * Routes with no `@RequireCapability` decorator pass through unchecked — this
 * guard enforces capability, not authentication.
 */
@Injectable()
export class CapabilityGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredCapability = this.reflector.getAllAndOverride<string | undefined>(
      CAPABILITY_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredCapability) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const staffContext = request.staffContext;

    if (!staffContext) {
      throw new ForbiddenException(
        'No resolved staff context on this request — is StaffContextGuard registered before CapabilityGuard?',
      );
    }

    if (!staffContext.capabilities.includes(requiredCapability)) {
      throw new ForbiddenException(`Missing required capability: ${requiredCapability}`);
    }

    return true;
  }
}
