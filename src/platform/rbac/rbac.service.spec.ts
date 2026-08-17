import { MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';

import { ModuleName, StaffRole } from '../../common/enums/identity.enums';
import { InMemoryMongo } from '../../test-utils/in-memory-mongo';
import { approveCapability, initiateCapability, reviewCapability } from './constants/capabilities';
import { RbacService } from './rbac.service';
import { RoleCapabilities, RoleCapabilitiesSchema } from './schemas/role-capabilities.schema';
import { StaffModuleAccess, StaffModuleAccessSchema } from './schemas/staff-module-access.schema';

describe('RbacService', () => {
  const mongo = new InMemoryMongo();
  let moduleRef: TestingModule;
  let rbacService: RbacService;

  beforeAll(async () => {
    await mongo.start();

    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri()),
        MongooseModule.forFeature([
          { name: RoleCapabilities.name, schema: RoleCapabilitiesSchema },
          { name: StaffModuleAccess.name, schema: StaffModuleAccessSchema },
        ]),
      ],
      providers: [RbacService],
    }).compile();

    rbacService = moduleRef.get(RbacService);
    await rbacService.onModuleInit();
  }, 60_000);

  afterAll(async () => {
    await moduleRef.close();
    await mongo.stop();
  });

  describe('default capability seed', () => {
    it('gives MARKETER no review or approve capability — only initiate plus flat operational capabilities', async () => {
      const capabilities = await rbacService.getCapabilitiesForRole(StaffRole.MARKETER);

      expect(capabilities.length).toBeGreaterThan(0);
      expect(capabilities.some((c) => c.startsWith('workflow:initiate:'))).toBe(true);
      expect(capabilities.some((c) => c.startsWith('workflow:review:'))).toBe(false);
      expect(capabilities.some((c) => c.startsWith('workflow:approve:'))).toBe(false);
      // Every capability is either an initiate-step one, or a flat,
      // non-workflow operational capability (e.g. Phase 8's
      // LOAN_DISBURSEMENT_OPS_CAPABILITY) — never review/approve either way.
      expect(
        capabilities.every((c) => c.startsWith('workflow:initiate:') || !c.startsWith('workflow:')),
      ).toBe(true);
    });

    it('gives APPROVER no initiate or review capability, only approve', async () => {
      const capabilities = await rbacService.getCapabilitiesForRole(StaffRole.APPROVER);

      expect(capabilities.length).toBeGreaterThan(0);
      expect(capabilities.every((c) => c.startsWith('workflow:approve:'))).toBe(true);
    });

    it('gives MANAGER initiate + review, but not approve', async () => {
      const capabilities = await rbacService.getCapabilitiesForRole(StaffRole.MANAGER);

      expect(capabilities.some((c) => c.startsWith('workflow:initiate:'))).toBe(true);
      expect(capabilities.some((c) => c.startsWith('workflow:review:'))).toBe(true);
      expect(capabilities.some((c) => c.startsWith('workflow:approve:'))).toBe(false);
    });

    it('only grants rbac:manage to SUPERADMIN, not ADMIN', async () => {
      const admin = await rbacService.getCapabilitiesForRole(StaffRole.ADMIN);
      const superadmin = await rbacService.getCapabilitiesForRole(StaffRole.SUPERADMIN);

      expect(admin).not.toContain('rbac:manage');
      expect(superadmin).toContain('rbac:manage');
    });

    it('does not overwrite a role capability edit on a second onModuleInit (upsert-on-insert-only)', async () => {
      await rbacService.setCapabilitiesForRole(StaffRole.MARKETER, ['custom:capability']);

      await rbacService.onModuleInit();

      const capabilities = await rbacService.getCapabilitiesForRole(StaffRole.MARKETER);
      expect(capabilities).toEqual(['custom:capability']);

      // restore for subsequent tests in this file
      await rbacService.setCapabilitiesForRole(StaffRole.MARKETER, [
        initiateCapability('CUSTOMER'),
      ]);
    });
  });

  describe('resolveContext', () => {
    it('combines role capabilities with staff module access', async () => {
      await rbacService.setModulesForStaff('staff-42', [ModuleName.LOANS]);

      const context = await rbacService.resolveContext({
        staffId: 'staff-42',
        role: StaffRole.MANAGER,
        branchId: 'branch-1',
      });

      expect(context.staffId).toBe('staff-42');
      expect(context.branchId).toBe('branch-1');
      expect(context.modules).toEqual([ModuleName.LOANS]);
      expect(context.capabilities).toEqual(
        await rbacService.getCapabilitiesForRole(StaffRole.MANAGER),
      );
    });

    it('returns an empty modules array for a staff member with no module access set', async () => {
      const context = await rbacService.resolveContext({
        staffId: 'staff-unset',
        role: StaffRole.MARKETER,
      });

      expect(context.modules).toEqual([]);
    });
  });

  describe('capability naming helpers', () => {
    it('produce the documented convention', () => {
      expect(initiateCapability('GROUP')).toBe('workflow:initiate:GROUP');
      expect(reviewCapability('GROUP')).toBe('workflow:review:GROUP');
      expect(approveCapability('LOAN')).toBe('workflow:approve:LOAN');
    });
  });
});
