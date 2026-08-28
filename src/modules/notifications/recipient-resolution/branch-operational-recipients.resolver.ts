import { Injectable } from '@nestjs/common';

import { StaffRole } from '../../../common/enums/identity.enums';
import { BranchManagerAssignmentService } from '../../branches/branch-manager-assignment.service';
import { BranchStaffRoleAssignmentService } from '../../branches/branch-staff-role-assignment.service';
import { StaffDocument } from '../../identity/schemas/staff.schema';
import { StaffService } from '../../identity/staff.service';

const ADMIN_APPROVER_FALLBACK_ROLES: readonly StaffRole[] = [StaffRole.ADMIN, StaffRole.SUPERADMIN];

/**
 * Branch-operational routing for the in-app notification bell — resolves
 * "who is the actor for this branch" for the two tiers this first pass
 * covers (see BranchOperationalEventListenersService, PHASE_13_NOTES.md's
 * scope note): a branch's manager-tier actions go to its current manager
 * (`BranchManagerAssignmentService.getCurrentManager` — unchanged,
 * pre-existing); its admin/approver-tier actions go to whoever is currently
 * assigned via `BranchStaffRoleAssignmentService` — the same "many-to-many,
 * per-branch" lookup Part A of this feature added.
 */
@Injectable()
export class BranchOperationalRecipientsResolver {
  constructor(
    private readonly branchManagerAssignmentService: BranchManagerAssignmentService,
    private readonly branchStaffRoleAssignmentService: BranchStaffRoleAssignmentService,
    private readonly staffService: StaffService,
  ) {}

  /** The branch's current manager, or `[]` (not a throw) if none is assigned — a branch's manager slot can legitimately sit empty. */
  async resolveManager(branchId: string): Promise<StaffDocument[]> {
    const current = await this.branchManagerAssignmentService.getCurrentManager(branchId);
    if (!current) {
      return [];
    }
    const manager = await this.staffService.findById(current.staffId.toString()).catch(() => null);
    return manager ? [manager] : [];
  }

  /**
   * Every ADMIN/APPROVER currently assigned to cover this branch. Falls back
   * to `findActiveByRoleAndBranch([ADMIN, SUPERADMIN], branchId)` — the same
   * shape `InvolvedPartiesResolver`'s own broadcast fallback already uses —
   * when nobody is currently assigned, so a branch with no coverage set up
   * yet doesn't just go unnotified.
   */
  async resolveAdminApprovers(branchId: string): Promise<StaffDocument[]> {
    const assigned = await this.branchStaffRoleAssignmentService.getStaffForBranch(branchId);
    if (assigned.length > 0) {
      const staffIds = assigned.map((row) => row.staffId.toString());
      return this.staffService.findByIds(staffIds);
    }
    return this.staffService.findActiveByRoleAndBranch([...ADMIN_APPROVER_FALLBACK_ROLES], branchId);
  }
}
