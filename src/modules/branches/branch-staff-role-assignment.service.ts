import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { StaffStatus } from '../../common/enums/identity.enums';
import { WorkflowEntityType } from '../../common/enums/workflow.enums';
import { AuditService } from '../../platform/audit/audit.service';
import { approveCapability } from '../../platform/rbac/constants/capabilities';
import {
  WORKFLOW_APPROVED_EVENT,
  WorkflowApprovedEvent,
} from '../../platform/workflow-engine/events/workflow-engine.events';
import { WorkflowRequestDocument } from '../../platform/workflow-engine/schemas/workflow-request.schema';
import { WorkflowEngineService } from '../../platform/workflow-engine/workflow-engine.service';
// Cross-module raw Staff model read only — same pattern as
// BranchManagerAssignmentService. See PHASE_3_NOTES.md.
import { Staff, StaffDocument } from '../identity/schemas/staff.schema';
import { BRANCH_ROLE_ASSIGNED_EVENT, BranchRoleAssignedEvent } from './events/branch.events';
import { Branch, BranchDocument } from './schemas/branch.schema';
import {
  BRANCH_STAFF_ASSIGNMENT_ROLES,
  BranchStaffAssignmentRole,
  BranchStaffRoleAssignment,
  BranchStaffRoleAssignmentDocument,
} from './schemas/branch-staff-role-assignment.schema';

const ASSIGN_ACTION = 'ASSIGN';

interface BranchStaffRoleAssignmentPayload {
  staffId: string;
  branchIds: string[];
  role: BranchStaffAssignmentRole;
  comments: string | null;
}

/**
 * Assigning an ADMIN/APPROVER to cover one or more branches is a
 * maker-checker workflow (see WorkflowEntityType.BRANCH_ROLE_ASSIGNMENT's
 * own doc comment) — same "a different Admin/SuperAdmin/Approver must
 * approve" shape as BranchManagerAssignmentService, but many-to-many and
 * batch: a single proposal names a whole list of branchIds, and one
 * approve/reject decision applies to the entire batch at once.
 * `initiateAssignment` validates and raises the proposal; the real mutation
 * only ever happens inside the WORKFLOW_APPROVED_EVENT handler below.
 *
 * Revoking coverage of one branch (`revokeAssignment`) is deliberately NOT
 * workflow-mediated — it only ever removes authority, never grants it, the
 * same asymmetric-risk reasoning behind other direct-vs-workflow splits in
 * this codebase (e.g. LEAVE_CANCEL_APPROVED_CAPABILITY letting a single
 * actor cancel already-approved leave). Gated by
 * `approveCapability(BRANCH_ROLE_ASSIGNMENT)` — the same tier that could
 * approve a fresh grant.
 */
@Injectable()
export class BranchStaffRoleAssignmentService implements OnModuleInit {
  constructor(
    @InjectModel(BranchStaffRoleAssignment.name)
    private readonly assignmentModel: Model<BranchStaffRoleAssignmentDocument>,
    @InjectModel(Staff.name) private readonly staffModel: Model<StaffDocument>,
    @InjectModel(Branch.name) private readonly branchModel: Model<BranchDocument>,
    private readonly auditService: AuditService,
    private readonly workflowEngineService: WorkflowEngineService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.workflowEngineService.registerChainConfig({
      entityType: WorkflowEntityType.BRANCH_ROLE_ASSIGNMENT,
      action: ASSIGN_ACTION,
      restartOnReturn: true,
      steps: [
        {
          order: 0,
          requiredCapability: approveCapability(WorkflowEntityType.BRANCH_ROLE_ASSIGNMENT),
        },
      ],
    });

    // Re-validated at the final approval step too, not just at proposal
    // time — same "fail late, safely" reasoning as
    // BranchManagerAssignmentService's own pre-approval validator.
    this.workflowEngineService.registerPreApprovalValidator(
      WorkflowEntityType.BRANCH_ROLE_ASSIGNMENT,
      ASSIGN_ACTION,
      async (request) => {
        const payload = request.payloadHistory[request.payloadHistory.length - 1]
          ?.payload as unknown as BranchStaffRoleAssignmentPayload;
        await this.assertEligible(payload.staffId, payload.branchIds, payload.role);
      },
    );
  }

  /** Shared by initiateAssignment (fail fast) and the pre-approval re-check (fail late, safely). */
  private async assertEligible(
    staffId: string,
    branchIds: string[],
    role: BranchStaffAssignmentRole,
  ): Promise<void> {
    if (!BRANCH_STAFF_ASSIGNMENT_ROLES.includes(role)) {
      throw new BadRequestException(`role must be one of ${BRANCH_STAFF_ASSIGNMENT_ROLES.join(', ')}`);
    }
    if (branchIds.length === 0) {
      throw new BadRequestException('branchIds must not be empty');
    }

    const staff = await this.staffModel.findById(staffId).exec();
    if (!staff) {
      throw new BadRequestException(`Staff ${staffId} does not exist`);
    }
    if (staff.role !== role) {
      throw new BadRequestException(
        `Staff ${staffId} has role ${staff.role}, not ${role} — only a ${role} can be assigned this way`,
      );
    }
    if (staff.status !== StaffStatus.ACTIVE) {
      throw new BadRequestException(`Staff ${staffId} is not ACTIVE`);
    }

    const existingCount = await this.branchModel.countDocuments({ _id: { $in: branchIds } }).exec();
    if (existingCount !== new Set(branchIds).size) {
      throw new BadRequestException('One or more branchIds do not exist');
    }
  }

  /**
   * Raises a batch assignment proposal — nothing is assigned yet. Eagerly
   * validated here (not just at the final approval step) so an obviously
   * invalid proposal never gets to sit in someone's approval queue at all.
   */
  async initiateAssignment(
    staffId: string,
    branchIds: string[],
    role: BranchStaffAssignmentRole,
    comments: string | undefined,
    initiatedBy: string,
  ): Promise<WorkflowRequestDocument> {
    const dedupedBranchIds = [...new Set(branchIds)];
    await this.assertEligible(staffId, dedupedBranchIds, role);

    const payload: BranchStaffRoleAssignmentPayload = {
      staffId,
      branchIds: dedupedBranchIds,
      role,
      comments: comments?.trim() || null,
    };

    return this.workflowEngineService.initiate({
      entityType: WorkflowEntityType.BRANCH_ROLE_ASSIGNMENT,
      action: ASSIGN_ACTION,
      payload: payload as unknown as Record<string, unknown>,
      initiatedBy,
      // No single branch to attribute this request to — it's a batch. This
      // field is pure audit/display metadata elsewhere (never used to scope
      // approval eligibility — see WorkflowEngineService.initiate), so
      // leaving it null here rather than picking branchIds[0] avoids
      // misleadingly implying single-branch scoping to anything that reads
      // it later. The full list lives in payload.branchIds.
      branchId: null,
    });
  }

  @OnEvent(WORKFLOW_APPROVED_EVENT)
  async handleWorkflowApproved(event: WorkflowApprovedEvent): Promise<void> {
    if (
      (event.entityType as WorkflowEntityType) !== WorkflowEntityType.BRANCH_ROLE_ASSIGNMENT ||
      event.action !== ASSIGN_ACTION
    ) {
      return;
    }

    const payload = event.payload as unknown as BranchStaffRoleAssignmentPayload;
    await this.applyAssignment(
      payload.staffId,
      payload.branchIds,
      payload.role,
      event.initiatedBy,
      event.approvedBy,
      payload.comments,
    );
  }

  /**
   * Upserts one active row per branch in the batch — idempotent (a branch
   * the staff member already actively covers just no-ops onto its existing
   * row rather than throwing or duplicating, via the partial unique index),
   * and never both-active-and-closed at once for the same (staff, branch,
   * role) since this only ever inserts, never closes a prior row (unlike
   * BranchManagerAssignmentService.applyAssignment, which replaces). Only
   * ever invoked from the WORKFLOW_APPROVED_EVENT handler above.
   */
  private async applyAssignment(
    staffId: string,
    branchIds: string[],
    role: BranchStaffAssignmentRole,
    assignedBy: string,
    approvedBy: string,
    comments: string | null,
  ): Promise<BranchStaffRoleAssignmentDocument[]> {
    const now = new Date();
    const created: BranchStaffRoleAssignmentDocument[] = [];

    for (const branchId of branchIds) {
      const row = await this.assignmentModel
        .findOneAndUpdate(
          { staffId: new Types.ObjectId(staffId), branchId: new Types.ObjectId(branchId), role, endDate: null },
          {
            $setOnInsert: {
              staffId: new Types.ObjectId(staffId),
              branchId: new Types.ObjectId(branchId),
              role,
              startDate: now,
              endDate: null,
              assignedBy: new Types.ObjectId(assignedBy),
              approvedBy: new Types.ObjectId(approvedBy),
              comments,
            },
          },
          { upsert: true, new: true },
        )
        .exec();
      created.push(row);

      await this.auditService.record({
        actorId: approvedBy,
        action: 'BRANCH_ROLE_ASSIGNED',
        entityType: 'BRANCH',
        entityId: branchId,
        after: { staffId, role, assignedBy, approvedBy },
      });
    }

    // NotificationsModule's own listener turns this into a per-branch
    // notification to the newly-assigned staff member — this module never
    // calls NotificationService directly (same decoupling shape as
    // BRANCH_MANAGER_ASSIGNED_EVENT, see branches/events/branch.events.ts).
    this.eventEmitter.emit(BRANCH_ROLE_ASSIGNED_EVENT, {
      staffId,
      branchIds,
      role,
      assignedBy,
      approvedBy,
    } satisfies BranchRoleAssignedEvent);

    return created;
  }

  /** Closes exactly the targeted (staffId, branchId, role) row — direct action, see this class's own doc comment. */
  async revokeAssignment(
    staffId: string,
    branchId: string,
    role: BranchStaffAssignmentRole,
    revokedBy: string,
    reason?: string,
  ): Promise<BranchStaffRoleAssignmentDocument> {
    const row = await this.assignmentModel
      .findOneAndUpdate(
        { staffId, branchId, role, endDate: null },
        { $set: { endDate: new Date() } },
        { new: true },
      )
      .exec();

    if (!row) {
      throw new NotFoundException(
        `Staff ${staffId} has no active ${role} coverage of branch ${branchId} to revoke`,
      );
    }

    await this.auditService.record({
      actorId: revokedBy,
      action: 'BRANCH_ROLE_ASSIGNMENT_REVOKED',
      entityType: 'BRANCH',
      entityId: branchId,
      before: { staffId, role },
      metadata: reason ? { reason } : null,
    });

    return row;
  }

  /** Every staff member currently covering this branch, optionally narrowed to one role. */
  async getStaffForBranch(
    branchId: string,
    role?: BranchStaffAssignmentRole,
  ): Promise<BranchStaffRoleAssignmentDocument[]> {
    return this.assignmentModel.find({ branchId, endDate: null, ...(role ? { role } : {}) }).exec();
  }

  /** Every branch this staff member currently covers, optionally narrowed to one role — the reverse lookup, no manager-side equivalent exists. */
  async getBranchesForStaff(
    staffId: string,
    role?: BranchStaffAssignmentRole,
  ): Promise<BranchStaffRoleAssignmentDocument[]> {
    return this.assignmentModel.find({ staffId, endDate: null, ...(role ? { role } : {}) }).exec();
  }

  async getHistory(filter: {
    staffId?: string;
    branchId?: string;
  }): Promise<BranchStaffRoleAssignmentDocument[]> {
    return this.assignmentModel.find(filter).sort({ startDate: -1 }).exec();
  }
}
