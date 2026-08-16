import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';

import { ModuleName } from '../../../common/enums/identity.enums';
import '../interfaces/staff-context.interface';
import { MODULE_METADATA_KEY } from '../decorators/require-module.decorator';

/**
 * Checks the `@RequireModule(...)` dimension only — independent of capability.
 * Must run after StaffContextGuard. Routes with no `@RequireModule` decorator
 * pass through unchecked.
 */
@Injectable()
export class ModuleAccessGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredModule = this.reflector.getAllAndOverride<ModuleName | undefined>(
      MODULE_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredModule) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const staffContext = request.staffContext;

    if (!staffContext) {
      throw new ForbiddenException(
        'No resolved staff context on this request — is StaffContextGuard registered before ModuleAccessGuard?',
      );
    }

    if (!staffContext.modules.includes(requiredModule)) {
      throw new ForbiddenException(`Missing required module access: ${requiredModule}`);
    }

    return true;
  }
}
