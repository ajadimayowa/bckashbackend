import { StaffRole } from '../../../common/enums/identity.enums';
import { BranchOperationalRecipientsResolver } from './branch-operational-recipients.resolver';

describe('BranchOperationalRecipientsResolver', () => {
  const branchId = 'branch-1';

  function build() {
    const branchManagerAssignmentService = { getCurrentManager: jest.fn() };
    const branchStaffRoleAssignmentService = { getStaffForBranch: jest.fn() };
    const staffService = { findById: jest.fn(), findByIds: jest.fn(), findActiveByRoleAndBranch: jest.fn() };

    const resolver = new BranchOperationalRecipientsResolver(
      branchManagerAssignmentService as never,
      branchStaffRoleAssignmentService as never,
      staffService as never,
    );

    return { resolver, branchManagerAssignmentService, branchStaffRoleAssignmentService, staffService };
  }

  describe('resolveManager', () => {
    it('returns [] (not a throw) for a branch with no current manager', async () => {
      const { resolver, branchManagerAssignmentService } = build();
      branchManagerAssignmentService.getCurrentManager.mockResolvedValue(null);

      await expect(resolver.resolveManager(branchId)).resolves.toEqual([]);
    });

    it('returns the resolved manager staff record', async () => {
      const { resolver, branchManagerAssignmentService, staffService } = build();
      branchManagerAssignmentService.getCurrentManager.mockResolvedValue({ staffId: { toString: () => 'staff-1' } });
      staffService.findById.mockResolvedValue({ id: 'staff-1' });

      const result = await resolver.resolveManager(branchId);
      expect(staffService.findById).toHaveBeenCalledWith('staff-1');
      expect(result).toEqual([{ id: 'staff-1' }]);
    });
  });

  describe('resolveAdminApprovers', () => {
    it('returns Feature 1\'s assigned staff when present', async () => {
      const { resolver, branchStaffRoleAssignmentService, staffService } = build();
      branchStaffRoleAssignmentService.getStaffForBranch.mockResolvedValue([
        { staffId: { toString: () => 'admin-1' } },
        { staffId: { toString: () => 'admin-2' } },
      ]);
      staffService.findByIds.mockResolvedValue([{ id: 'admin-1' }, { id: 'admin-2' }]);

      const result = await resolver.resolveAdminApprovers(branchId);

      expect(staffService.findByIds).toHaveBeenCalledWith(['admin-1', 'admin-2']);
      expect(staffService.findActiveByRoleAndBranch).not.toHaveBeenCalled();
      expect(result).toEqual([{ id: 'admin-1' }, { id: 'admin-2' }]);
    });

    it('falls back to findActiveByRoleAndBranch([ADMIN, SUPERADMIN]) when nobody is assigned', async () => {
      const { resolver, branchStaffRoleAssignmentService, staffService } = build();
      branchStaffRoleAssignmentService.getStaffForBranch.mockResolvedValue([]);
      staffService.findActiveByRoleAndBranch.mockResolvedValue([{ id: 'admin-3' }]);

      const result = await resolver.resolveAdminApprovers(branchId);

      expect(staffService.findActiveByRoleAndBranch).toHaveBeenCalledWith(
        [StaffRole.ADMIN, StaffRole.SUPERADMIN],
        branchId,
      );
      expect(result).toEqual([{ id: 'admin-3' }]);
    });
  });
});
