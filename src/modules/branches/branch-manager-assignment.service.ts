import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { StaffRole, StaffStatus } from '../../common/enums/identity.enums';
import { WorkflowEntityType } from '../../common/enums/workflow.enums';
import { AuditService } from '../../platform/audit/audit.service';
import { approveCapability } from '../../platform/rbac/constants/capabilities';
import {
  WORKFLOW_APPROVED_EVENT,
  WorkflowApprovedEvent,
} from '../../platform/workflow-engine/events/workflow-engine.events';
import { WorkflowRequestDocument } from '../../platform/workflow-engine/schemas/workflow-request.schema';
import { WorkflowEngineService } from '../../platform/workflow-engine/workflow-engine.service';
// Cross-module raw Staff model read/write only — same pattern as this
// module's other cross-module registrations. See PHASE_3_NOTES.md.
import { Staff, StaffDocument } from '../identity/schemas/staff.schema';
import { BRANCH_MANAGER_ASSIGNED_EVENT, BranchManagerAssignedEvent } from './events/branch.events';
import { Branch, BranchDocument } from './schemas/branch.schema';
import {
  BranchManagerAssignment,
  BranchManagerAssignmentDocument,
} from './schemas/branch-manager-assignment.schema';

const ASSIGN_ACTION = 'ASSIGN';

interface BranchManagerAssignmentPayload {
  branchId: string;
  staffId: string;
  comments: string | null;
}

/**
 * Assigning a branch manager is a maker-checker workflow (see
 * WorkflowEntityType.BRANCH_MANAGER_ASSIGNMENT's own doc comment) — a
 * proposal only ever takes effect once a *different* Admin/SuperAdmin/
 * Approver approves it. This mirrors every other config-style single-step
 * chain in the app (LOAN_PRODUCT, SALARY_RECORD, ...): `initiateAssignment`
 * validates and raises the proposal; the real mutation only ever happens
 * inside the WORKFLOW_APPROVED_EVENT handler below.
 */
@Injectable()
export class BranchManagerAssignmentService implements OnModuleInit {
  constructor(
    @InjectModel(BranchManagerAssignment.name)
    private readonly assignmentModel: Model<BranchManagerAssignmentDocument>,
    @InjectModel(Staff.name) private readonly staffModel: Model<StaffDocument>,
    @InjectModel(Branch.name) private readonly branchModel: Model<BranchDocument>,
    private readonly auditService: AuditService,
    private readonly workflowEngineService: WorkflowEngineService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.workflowEngineService.registerChainConfig({
      entityType: WorkflowEntityType.BRANCH_MANAGER_ASSIGNMENT,
      action: ASSIGN_ACTION,
      restartOnReturn: true,
      steps: [
        {
          order: 0,
          requiredCapability: approveCapability(WorkflowEntityType.BRANCH_MANAGER_ASSIGNMENT),
        },
      ],
    });

    // Re-validated at the final approval step too, not just at proposal
    // time — a proposal can sit pending for a while, during which the
    // target staff member could be disabled, reassigned to MARKETER, or
    // (far-fetched but not impossible) the branch itself deleted. Better to
    // fail the approval loudly than silently assign a now-ineligible staff
    // member. See PreApprovalValidator's own doc comment (workflow-engine.service.ts).
    this.workflowEngineService.registerPreApprovalValidator(
      WorkflowEntityType.BRANCH_MANAGER_ASSIGNMENT,
      ASSIGN_ACTION,
      async (request) => {
        const payload = request.payloadHistory[request.payloadHistory.length - 1]
          ?.payload as unknown as BranchManagerAssignmentPayload;
        await this.assertEligible(payload.branchId, payload.staffId);
      },
    );
  }

  /** Shared by initiateAssignment (fail fast) and the pre-approval re-check (fail late, safely). */
  private async assertEligible(branchId: string, staffId: string): Promise<void> {
    const branchExists = await this.branchModel.exists({ _id: branchId });
    if (!branchExists) {
      throw new BadRequestException(`Branch ${branchId} does not exist`);
    }

    const staff = await this.staffModel.findById(staffId).exec();
    if (!staff) {
      throw new BadRequestException(`Staff ${staffId} does not exist`);
    }
    // ASSUMPTION (carried over from the pre-workflow direct-assignment
    // version of this service): only MANAGER-role staff can be assigned as
    // a branch manager.
    if (staff.role !== StaffRole.MANAGER) {
      throw new BadRequestException(
        `Staff ${staffId} has role ${staff.role}, not MANAGER — only a MANAGER can be assigned as branch manager`,
      );
    }
    if (staff.status !== StaffStatus.ACTIVE) {
      throw new BadRequestException(`Staff ${staffId} is not ACTIVE`);
    }
  }

  /**
   * Raises a manager-assignment proposal — nothing is assigned yet. Eagerly
   * validated here (not just at the final approval step) so an obviously
   * invalid proposal never gets to sit in someone's approval queue at all.
   */
  async initiateAssignment(
    branchId: string,
    staffId: string,
    comments: string | undefined,
    initiatedBy: string,
  ): Promise<WorkflowRequestDocument> {
    await this.assertEligible(branchId, staffId);

    const payload: BranchManagerAssignmentPayload = {
      branchId,
      staffId,
      comments: comments?.trim() || null,
    };

    return this.workflowEngineService.initiate({
      entityType: WorkflowEntityType.BRANCH_MANAGER_ASSIGNMENT,
      action: ASSIGN_ACTION,
      payload: payload as unknown as Record<string, unknown>,
      initiatedBy,
      branchId,
    });
  }

  @OnEvent(WORKFLOW_APPROVED_EVENT)
  async handleWorkflowApproved(event: WorkflowApprovedEvent): Promise<void> {
    if (
      (event.entityType as WorkflowEntityType) !== WorkflowEntityType.BRANCH_MANAGER_ASSIGNMENT ||
      event.action !== ASSIGN_ACTION
    ) {
      return;
    }

    const payload = event.payload as unknown as BranchManagerAssignmentPayload;
    await this.applyAssignment(
      payload.branchId,
      payload.staffId,
      event.initiatedBy,
      event.approvedBy,
      payload.comments,
    );
  }

  /**
   * Closes any existing active assignment for the branch, then opens a new
   * one — never both active at once (also enforced at the DB level by the
   * partial unique index on { branchId, endDate: null }, so a concurrent
   * double-assign can't slip through even if this read-then-write raced).
   * Only ever invoked from the WORKFLOW_APPROVED_EVENT handler above.
   */
  private async applyAssignment(
    branchId: string,
    staffId: string,
    assignedBy: string,
    approvedBy: string,
    comments: string | null,
  ): Promise<BranchManagerAssignmentDocument> {
    const previous = await this.getCurrentManager(branchId);
    const now = new Date();

    if (previous) {
      await this.assignmentModel
        .updateOne({ _id: previous._id }, { $set: { endDate: now } })
        .exec();
    }

    const created = await this.assignmentModel.create({
      branchId: new Types.ObjectId(branchId),
      staffId: new Types.ObjectId(staffId),
      startDate: now,
      endDate: null,
      assignedBy: new Types.ObjectId(assignedBy),
      approvedBy: new Types.ObjectId(approvedBy),
      comments,
    });

    // Keep Staff.branchId (their *workplace* — see residential-address.schema.ts's
    // own doc comment distinguishing it from where they live) in sync with this
    // assignment. Without this, everything gated by the manager's own
    // request-scoped branchId — most importantly BranchFundingService.findAll's
    // row-scoping — silently shows nothing for a manager who was assigned to a
    // *different* branch than the one they were hired into, even though
    // branch-specific actions like nudging them still work fine (those look up
    // the current manager via this assignment table directly, not staff.branchId).
    // Takes effect on the manager's *next* login — their current JWT/session
    // still carries whatever branchId it was issued with.
    await this.staffModel
      .updateOne({ _id: staffId }, { $set: { branchId: new Types.ObjectId(branchId) } })
      .exec();

    await this.auditService.record({
      actorId: approvedBy,
      action: 'BRANCH_MANAGER_ASSIGNED',
      entityType: 'BRANCH',
      entityId: branchId,
      before: previous ? { managerId: previous.staffId.toString() } : null,
      after: { managerId: staffId, assignedBy, approvedBy },
    });

    // NotificationsModule's own BranchEventListenersService turns this into
    // the BRANCH_MANAGER_ASSIGNED email to the newly-assigned manager —
    // this module never calls NotificationService directly (see this
    // event's own doc comment, branches/events/branch.events.ts).
    this.eventEmitter.emit(BRANCH_MANAGER_ASSIGNED_EVENT, {
      branchId,
      staffId,
      assignedBy,
      approvedBy,
    } satisfies BranchManagerAssignedEvent);

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
