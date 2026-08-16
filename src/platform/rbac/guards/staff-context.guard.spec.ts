import { ExecutionContext, UnauthorizedException } from '@nestjs/common';

import { ModuleName, StaffRole } from '../../../common/enums/identity.enums';
import '../interfaces/staff-context.interface';
import { RbacService } from '../rbac.service';
import { StaffContextGuard } from './staff-context.guard';

function makeContext(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('StaffContextGuard', () => {
  it('throws UnauthorizedException when request.user is missing', async () => {
    const rbacService = { resolveContext: jest.fn() } as unknown as RbacService;
    const guard = new StaffContextGuard(rbacService);

    await expect(guard.canActivate(makeContext({}))).rejects.toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException when request.user is missing a role', async () => {
    const rbacService = { resolveContext: jest.fn() } as unknown as RbacService;
    const guard = new StaffContextGuard(rbacService);

    const request = { user: { staffId: 'staff-1' } };

    await expect(guard.canActivate(makeContext(request))).rejects.toThrow(UnauthorizedException);
  });

  it('resolves the context via RbacService and attaches it to the request', async () => {
    const resolved = {
      staffId: 'staff-1',
      role: StaffRole.MANAGER,
      capabilities: ['workflow:review:LOAN'],
      modules: [ModuleName.LOANS],
    };
    const resolveContextMock = jest.fn().mockResolvedValue(resolved);
    const rbacService = { resolveContext: resolveContextMock } as unknown as RbacService;
    const guard = new StaffContextGuard(rbacService);

    const request: Record<string, unknown> = {
      user: { staffId: 'staff-1', role: StaffRole.MANAGER },
    };

    const result = await guard.canActivate(makeContext(request));

    expect(result).toBe(true);
    expect(request.staffContext).toEqual(resolved);
    expect(resolveContextMock).toHaveBeenCalledWith(request.user);
  });
});
