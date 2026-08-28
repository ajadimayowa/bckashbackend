import { MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';

import { ModuleName, StaffRole, StaffUserType } from '../../common/enums/identity.enums';
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

    it('gives APPROVER no review capability, and only one initiate exception (BRANCH — an explicit product decision), otherwise only approve', async () => {
      const capabilities = await rbacService.getCapabilitiesForRole(StaffRole.APPROVER);

      expect(capabilities.length).toBeGreaterThan(0);
      expect(capabilities.some((c) => c.startsWith('workflow:review:'))).toBe(false);
      expect(capabilities).toContain(initiateCapability('BRANCH'));
      expect(
        capabilities.every(
          (c) => c.startsWith('workflow:approve:') || c === initiateCapability('BRANCH'),
        ),
      ).toBe(true);
    });

    it('gives MANAGER initiate + review, plus one approve exception (STAFF — the Initiator/Authorizer RBAC feature\'s same-role peer-approval grant, see StaffService.onModuleInit)', async () => {
      const capabilities = await rbacService.getCapabilitiesForRole(StaffRole.MANAGER);

      expect(capabilities.some((c) => c.startsWith('workflow:initiate:'))).toBe(true);
      expect(capabilities.some((c) => c.startsWith('workflow:review:'))).toBe(true);
      expect(capabilities).toContain(approveCapability('STAFF'));
      expect(capabilities.filter((c) => c.startsWith('workflow:approve:'))).toEqual([
        approveCapability('STAFF'),
      ]);
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

  describe('addCapabilityToRole / removeCapabilityFromRole', () => {
    it('adds a capability without disturbing the rest of the list', async () => {
      const before = await rbacService.getCapabilitiesForRole(StaffRole.MARKETER);

      const updated = await rbacService.addCapabilityToRole(StaffRole.MARKETER, 'test:add-capability');

      expect(updated.capabilities).toEqual(expect.arrayContaining([...before, 'test:add-capability']));
      expect(updated.capabilities).toHaveLength(before.length + 1);
    });

    it('is idempotent — granting an already-held capability does not duplicate it', async () => {
      const first = await rbacService.addCapabilityToRole(StaffRole.MARKETER, 'test:idempotent');
      const second = await rbacService.addCapabilityToRole(StaffRole.MARKETER, 'test:idempotent');

      expect(second.capabilities.filter((c) => c === 'test:idempotent')).toHaveLength(1);
      expect(second.capabilities).toEqual(first.capabilities);
    });

    it('removes exactly the one capability requested', async () => {
      await rbacService.addCapabilityToRole(StaffRole.MARKETER, 'test:to-remove');

      const updated = await rbacService.removeCapabilityFromRole(StaffRole.MARKETER, 'test:to-remove');

      expect(updated.capabilities).not.toContain('test:to-remove');
    });

    it('removing a capability the role never had is a harmless no-op', async () => {
      const before = await rbacService.getCapabilitiesForRole(StaffRole.MARKETER);

      const updated = await rbacService.removeCapabilityFromRole(StaffRole.MARKETER, 'test:never-granted');

      expect(updated.capabilities).toEqual(before);
    });

    afterAll(async () => {
      // restore for subsequent tests in this file
      await rbacService.setCapabilitiesForRole(StaffRole.MARKETER, [initiateCapability('CUSTOMER')]);
    });
  });

  describe('resolveContext', () => {
    it('combines role capabilities with staff module access', async () => {
      await rbacService.setModulesForStaff('staff-42', [ModuleName.LOANS]);

      const context = await rbacService.resolveContext({
        staffId: 'staff-42',
        role: StaffRole.MANAGER,
        branchId: 'branch-1',
        userType: StaffUserType.AUTHORIZER,
      });

      expect(context.staffId).toBe('staff-42');
      expect(context.branchId).toBe('branch-1');
      expect(context.modules).toEqual([ModuleName.LOANS]);
      // MANAGER holds both initiate and review capabilities — an
      // Authorizer-flagged Manager only keeps the review ones (plus flat,
      // non-workflow ones); see the "Initiator/Authorizer filtering" block
      // below for the full behavior this is a special case of.
      const roleCapabilities = await rbacService.getCapabilitiesForRole(StaffRole.MANAGER);
      expect(context.capabilities).toEqual(
        roleCapabilities.filter((c) => !c.startsWith('workflow:initiate:')),
      );
    });

    it('returns an empty modules array for a staff member with no module access set', async () => {
      const context = await rbacService.resolveContext({
        staffId: 'staff-unset',
        role: StaffRole.MARKETER,
        userType: StaffUserType.INITIATOR,
      });

      expect(context.modules).toEqual([]);
    });
  });

  describe('Initiator/Authorizer capability filtering', () => {
    it('an Initiator-flagged staff member keeps only initiate + flat capabilities — review/approve are stripped', async () => {
      const context = await rbacService.resolveContext({
        staffId: 'staff-initiator',
        role: StaffRole.MANAGER,
        userType: StaffUserType.INITIATOR,
      });

      expect(context.capabilities.some((c) => c.startsWith('workflow:initiate:'))).toBe(true);
      expect(context.capabilities.some((c) => c.startsWith('workflow:review:'))).toBe(false);
      expect(context.capabilities.some((c) => c.startsWith('workflow:approve:'))).toBe(false);
      // Flat, non-workflow capabilities (e.g. LOAN_DISBURSEMENT_OPS_CAPABILITY) survive untouched.
      expect(context.capabilities.some((c) => c === 'loan:disbursement_ops')).toBe(true);
    });

    it('an Authorizer-flagged staff member keeps only review/approve + flat capabilities — initiate is stripped', async () => {
      const context = await rbacService.resolveContext({
        staffId: 'staff-authorizer',
        role: StaffRole.MANAGER,
        userType: StaffUserType.AUTHORIZER,
      });

      expect(context.capabilities.some((c) => c.startsWith('workflow:initiate:'))).toBe(false);
      expect(context.capabilities.some((c) => c.startsWith('workflow:review:'))).toBe(true);
      expect(context.capabilities.some((c) => c === 'loan:disbursement_ops')).toBe(true);
    });

    it('a Reviewer-flagged (legacy) staff member gets neither initiate nor review/approve capabilities', async () => {
      const context = await rbacService.resolveContext({
        staffId: 'staff-legacy-reviewer',
        role: StaffRole.MANAGER,
        userType: StaffUserType.REVIEWER,
      });

      expect(context.capabilities.some((c) => c.startsWith('workflow:'))).toBe(false);
      // Flat capabilities are still unaffected either way.
      expect(context.capabilities.some((c) => c === 'loan:disbursement_ops')).toBe(true);
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
