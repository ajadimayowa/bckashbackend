import { CanActivate, ExecutionContext, INestApplication, Injectable } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Request } from 'express';
import request from 'supertest';

import { ModuleName } from '../../common/enums/identity.enums';
import { StaffContextGuard } from '../../platform/rbac/guards/staff-context.guard';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { HrLeaveController } from './hr-leave.controller';
import { HrSalaryController } from './hr-salary.controller';
import { LeaveApplicationService } from './leave-application.service';
import { LeaveBalanceService } from './leave-balance.service';
import { SalaryService } from './salary.service';

/**
 * Reads simulated auth context straight off request headers, set per-call
 * by supertest below — replaces the real JwtAuthGuard/StaffContextGuard
 * pipeline (already independently tested — `staff-context.guard.spec.ts`)
 * so this suite can drive many different actor shapes against the same
 * running app without a real login flow. `ModuleAccessGuard`/
 * `CapabilityGuard` are the REAL guards, unmodified — this is what's
 * actually under test: which routes they're attached to, per PHASE_12_NOTES.md.
 */
@Injectable()
class TestStaffContextGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    req.staffContext = {
      staffId: (req.headers['x-test-staff-id'] as string) ?? 'actor-1',
      role: (req.headers['x-test-role'] as never) ?? 'MARKETER',
      // Not exercised by this suite — capabilities come straight off a
      // header (see this class's own doc comment), bypassing
      // RbacService.resolveContext's real userType-based filtering
      // entirely. Just satisfying ResolvedStaffContext's required field.
      userType: 'Authorizer' as never,
      capabilities: req.headers['x-test-capabilities']
        ? (req.headers['x-test-capabilities'] as string).split(',')
        : [],
      modules: req.headers['x-test-modules']
        ? ((req.headers['x-test-modules'] as string).split(',') as ModuleName[])
        : [],
    };
    return true;
  }
}

describe('HR access control (self-access vs. module/capability-gated)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  const getCurrentSalary = jest.fn();
  const getSalaryHistory = jest.fn();
  const getAllSummariesForStaff = jest.fn();
  const findForStaff = jest.fn();

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      controllers: [HrLeaveController, HrSalaryController],
      providers: [
        {
          provide: LeaveApplicationService,
          useValue: { findForStaff, applyForLeave: jest.fn(), cancelApplication: jest.fn() },
        },
        { provide: LeaveBalanceService, useValue: { getAllSummariesForStaff } },
        {
          provide: SalaryService,
          useValue: { getCurrentSalary, getSalaryHistory, proposeSalaryChange: jest.fn() },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(StaffContextGuard)
      .useClass(TestStaffContextGuard)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    getCurrentSalary.mockResolvedValue({ staffId: 'self', baseSalaryKobo: 1 });
    getAllSummariesForStaff.mockResolvedValue([]);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('self-access — always allowed regardless of HR module assignment', () => {
    it('GET /hr/salary/mine succeeds with no HR module access and no capability', async () => {
      await request(app.getHttpServer() as Parameters<typeof request>[0])
        .get('/hr/salary/mine')
        .set('x-test-staff-id', 'me-1')
        .set('x-test-modules', '') // no module access at all
        .set('x-test-capabilities', '') // no capabilities at all
        .expect(200);

      expect(getCurrentSalary).toHaveBeenCalledWith('me-1'); // the caller's own id, structurally
    });

    it('GET /hr/leave/my-balance succeeds with no HR module access', async () => {
      await request(app.getHttpServer() as Parameters<typeof request>[0])
        .get('/hr/leave/my-balance')
        .set('x-test-staff-id', 'me-2')
        .set('x-test-modules', '')
        .expect(200);

      expect(getAllSummariesForStaff).toHaveBeenCalledWith('me-2', expect.any(Number));
    });
  });

  describe("another staff member's salary — requires BOTH HR module access AND HR_SALARY_MANAGE_CAPABILITY", () => {
    it('rejects with HR module access but no capability', async () => {
      await request(app.getHttpServer() as Parameters<typeof request>[0])
        .get('/hr/salary/staff/other-1')
        .set('x-test-modules', ModuleName.HR)
        .set('x-test-capabilities', '')
        .expect(403);
    });

    it('rejects with the capability but no HR module access', async () => {
      await request(app.getHttpServer() as Parameters<typeof request>[0])
        .get('/hr/salary/staff/other-1')
        .set('x-test-modules', '')
        .set('x-test-capabilities', 'hr:salary:manage')
        .expect(403);
    });

    it('succeeds with both HR module access and the capability', async () => {
      await request(app.getHttpServer() as Parameters<typeof request>[0])
        .get('/hr/salary/staff/other-1')
        .set('x-test-modules', ModuleName.HR)
        .set('x-test-capabilities', 'hr:salary:manage')
        .expect(200);

      expect(getCurrentSalary).toHaveBeenCalledWith('other-1');
    });
  });

  describe("another staff member's leave data — only standard HR module access needed", () => {
    it('rejects with no HR module access', async () => {
      await request(app.getHttpServer() as Parameters<typeof request>[0])
        .get('/hr/leave/staff/other-2/balance')
        .set('x-test-modules', '')
        .expect(403);
    });

    it('succeeds with HR module access alone — no extra capability required', async () => {
      await request(app.getHttpServer() as Parameters<typeof request>[0])
        .get('/hr/leave/staff/other-2/balance')
        .set('x-test-modules', ModuleName.HR)
        .set('x-test-capabilities', '')
        .expect(200);

      expect(getAllSummariesForStaff).toHaveBeenCalledWith('other-2', expect.any(Number));
    });
  });
});
