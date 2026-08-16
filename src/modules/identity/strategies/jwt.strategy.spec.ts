import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { StaffRole, StaffStatus } from '../../../common/enums/identity.enums';
import { StaffService } from '../staff.service';
import { JwtStrategy } from './jwt.strategy';

/**
 * `validate()` only ever runs on a token that Passport has already verified
 * (correct signature, not expired) — so a test where `validate()` still
 * rejects is exactly "a previously-issued, still-technically-valid access
 * token" being refused, which is the scenario the brief calls out explicitly.
 * This is the live-status-check half of token-invalidation-on-disable; the
 * other half (revoking outstanding refresh tokens) is covered in
 * staff.service.spec.ts and auth.service.spec.ts.
 */
describe('JwtStrategy', () => {
  const configService = {
    get: jest.fn().mockReturnValue({
      accessSecret: 'test-secret',
      accessExpiresIn: '15m',
    }),
  } as unknown as ConfigService;

  function makeStrategy(getStatus: jest.Mock): JwtStrategy {
    const staffService = { getStatus } as unknown as StaffService;
    return new JwtStrategy(configService, staffService);
  }

  it('rejects a disabled staff member even though their token is structurally still valid', async () => {
    const getStatus = jest.fn().mockResolvedValue(StaffStatus.DISABLED);
    const strategy = makeStrategy(getStatus);

    await expect(
      strategy.validate({ sub: 'staff-1', role: StaffRole.ADMIN, branchId: 'branch-1' }),
    ).rejects.toThrow(UnauthorizedException);
    expect(getStatus).toHaveBeenCalledWith('staff-1');
  });

  it('rejects when the staff record no longer exists', async () => {
    const getStatus = jest.fn().mockResolvedValue(null);
    const strategy = makeStrategy(getStatus);

    await expect(
      strategy.validate({ sub: 'staff-1', role: StaffRole.ADMIN, branchId: 'branch-1' }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('returns the resolved principal for an ACTIVE staff member', async () => {
    const getStatus = jest.fn().mockResolvedValue(StaffStatus.ACTIVE);
    const strategy = makeStrategy(getStatus);

    const principal = await strategy.validate({
      sub: 'staff-1',
      role: StaffRole.MANAGER,
      branchId: 'branch-1',
    });

    expect(principal).toEqual({
      staffId: 'staff-1',
      role: StaffRole.MANAGER,
      branchId: 'branch-1',
    });
  });
});
