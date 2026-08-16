import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ModuleName, StaffRole } from '../../../common/enums/identity.enums';
import '../interfaces/staff-context.interface';
import { CapabilityGuard } from './capability.guard';
import { ModuleAccessGuard } from './module-access.guard';

function makeContext(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
    getHandler: () => (): void => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

describe('CapabilityGuard + ModuleAccessGuard composition', () => {
  const staffContextWithBoth = {
    staffId: 'staff-1',
    role: StaffRole.MANAGER,
    capabilities: ['workflow:review:LOAN'],
    modules: [ModuleName.LOANS],
  };

  it('denies a staff member with the capability but not the module', () => {
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(ModuleName.LOANS);
    const guard = new ModuleAccessGuard(reflector);

    const request = {
      staffContext: { ...staffContextWithBoth, modules: [ModuleName.ACCOUNTING] },
    };

    expect(() => guard.canActivate(makeContext(request))).toThrow(ForbiddenException);
  });

  it('denies a staff member with the module but not the capability', () => {
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue('workflow:approve:LOAN');
    const guard = new CapabilityGuard(reflector);

    const request = { staffContext: staffContextWithBoth }; // only has workflow:review:LOAN

    expect(() => guard.canActivate(makeContext(request))).toThrow(ForbiddenException);
  });

  it('allows a staff member who has both the capability and the module', () => {
    const capabilityReflector = new Reflector();
    jest.spyOn(capabilityReflector, 'getAllAndOverride').mockReturnValue('workflow:review:LOAN');
    const capabilityGuard = new CapabilityGuard(capabilityReflector);

    const moduleReflector = new Reflector();
    jest.spyOn(moduleReflector, 'getAllAndOverride').mockReturnValue(ModuleName.LOANS);
    const moduleGuard = new ModuleAccessGuard(moduleReflector);

    const context = makeContext({ staffContext: staffContextWithBoth });

    expect(capabilityGuard.canActivate(context)).toBe(true);
    expect(moduleGuard.canActivate(context)).toBe(true);
  });

  it('CapabilityGuard passes routes with no @RequireCapability decorator through unchecked', () => {
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    const guard = new CapabilityGuard(reflector);

    expect(guard.canActivate(makeContext({}))).toBe(true);
  });

  it('ModuleAccessGuard passes routes with no @RequireModule decorator through unchecked', () => {
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    const guard = new ModuleAccessGuard(reflector);

    expect(guard.canActivate(makeContext({}))).toBe(true);
  });

  it('throws if StaffContextGuard never ran (no staffContext on the request)', () => {
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue('workflow:approve:LOAN');
    const guard = new CapabilityGuard(reflector);

    expect(() => guard.canActivate(makeContext({}))).toThrow(ForbiddenException);
  });
});
