import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { StaffRole, StaffStatus } from '../../common/enums/identity.enums';
import { AuditService } from '../../platform/audit/audit.service';
// Cross-module read only — the raw Staff model, not identity's StaffService or
// IdentityModule. Both modules independently register whichever of each
// other's schemas they need to read (see branches.module.ts / identity.module.ts)
// so neither module has to import the other's NestJS module. See PHASE_3_NOTES.md
// for why this was chosen over `forwardRef`.
import { Staff, StaffDocument } from '../identity/schemas/staff.schema';
import {
  BranchManagerAssignment,
  BranchManagerAssignmentDocument,
} from './schemas/branch-manager-assignment.schema';

@Injectable()
export class BranchManagerAssignmentService {
  constructor(
    @InjectModel(BranchManagerAssignment.name)
    private readonly assignmentModel: Model<BranchManagerAssignmentDocument>,
    @InjectModel(Staff.name) private readonly staffModel: Model<StaffDocument>,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Closes any existing active assignment for the branch, then opens a new
   * one — never both active at once (also enforced at the DB level by the
   * partial unique index on { branchId, endDate: null }, so a concurrent
   * double-assign can't slip through even if this read-then-write raced).
   */
  async assignManager(
    branchId: string,
    staffId: string,
    assignedBy: string,
  ): Promise<BranchManagerAssignmentDocument> {
    const staff = await this.staffModel.findById(staffId).exec();
    if (!staff) {
      throw new BadRequestException(`Staff ${staffId} does not exist`);
    }
    // ASSUMPTION (flagged in PHASE_3_NOTES.md): only MANAGER-role staff can be
    // assigned as a branch manager — the brief called this ambiguous.
    if (staff.role !== StaffRole.MANAGER) {
      throw new BadRequestException(
        `Staff ${staffId} has role ${staff.role}, not MANAGER — only a MANAGER can be assigned as branch manager`,
      );
    }
    if (staff.status !== StaffStatus.ACTIVE) {
      throw new BadRequestException(`Staff ${staffId} is not ACTIVE`);
    }

    const previous = await this.getCurrentManager(branchId);
    const now = new Date();

    if (previous) {
      await this.assignmentModel
        .updateOne({ _id: previous._id }, { $set: { endDate: now } })
        .exec();
    }

    const created = await this.assignmentModel.create({
      branchId,
      staffId,
      startDate: now,
      endDate: null,
      assignedBy,
    });

    await this.auditService.record({
      actorId: assignedBy,
      action: 'BRANCH_MANAGER_ASSIGNED',
      entityType: 'BRANCH',
      entityId: branchId,
      before: previous ? { managerId: previous.staffId.toString() } : null,
      after: { managerId: staffId },
    });

    return created;
  }

  /** The single sanctioned way to find a branch's current manager — see the schema's doc comment. */
  async getCurrentManager(branchId: string): Promise<BranchManagerAssignmentDocument | null> {
    return this.assignmentModel.findOne({ branchId, endDate: null }).exec();
  }

  async getHistory(branchId: string): Promise<BranchManagerAssignmentDocument[]> {
    return this.assignmentModel.find({ branchId }).sort({ startDate: -1 }).exec();
  }
}
