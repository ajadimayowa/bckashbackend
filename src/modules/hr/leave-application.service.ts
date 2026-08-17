import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { StaffRole, StaffStatus } from '../../common/enums/identity.enums';
import { LeaveApplicationStatus, LeaveChainAction } from '../../common/enums/hr.enums';
import { WorkflowEntityType } from '../../common/enums/workflow.enums';
import { AuditService } from '../../platform/audit/audit.service';
import {
  LEAVE_CANCEL_APPROVED_CAPABILITY,
  approveCapability,
  reviewCapability,
} from '../../platform/rbac/constants/capabilities';
import {
  WORKFLOW_APPROVED_EVENT,
  WORKFLOW_REJECTED_EVENT,
  WorkflowApprovedEvent,
  WorkflowRejectedEvent,
} from '../../platform/workflow-engine/events/workflow-engine.events';
import { WorkflowEngineService } from '../../platform/workflow-engine/workflow-engine.service';
import { BranchManagerAssignmentService } from '../branches/branch-manager-assignment.service';
import { StaffDocument } from '../identity/schemas/staff.schema';
import { StaffService } from '../identity/staff.service';
import { LeaveBalanceService } from './leave-balance.service';
import { LeaveApplication, LeaveApplicationDocument } from './schemas/leave-application.schema';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface LeaveActor {
  staffId: string;
  capabilities: string[];
}

/**
 * Owns the leave-application lifecycle: dynamic chain selection at
 * submission, the workflow.approved/rejected reactions, and cancellation
 * (both pre- and post-approval). See PHASE_12_NOTES.md for the full
 * routing/capability reasoning behind the three registered chains.
 */
@Injectable()
export class LeaveApplicationService implements OnModuleInit {
  constructor(
    @InjectModel(LeaveApplication.name)
    private readonly leaveApplicationModel: Model<LeaveApplicationDocument>,
    private readonly staffService: StaffService,
    private readonly branchManagerAssignmentService: BranchManagerAssignmentService,
    private readonly workflowEngineService: WorkflowEngineService,
    private readonly leaveBalanceService: LeaveBalanceService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Three distinct chains, all under `WorkflowEntityType.LEAVE_APPLICATION`
   * (the pre-existing Phase 1/2 enum value — the brief's own "LEAVE/..."
   * shorthand is reconciled onto this rather than introducing a new
   * `LEAVE` entityType; see PHASE_12_NOTES.md), distinguished by `action`:
   *
   * - APPROVE_STAFF: [review, approve] — review is
   *   `reviewCapability(LEAVE_APPLICATION)`, held by MANAGER (any manager,
   *   not staff-id-scoped to "the applicant's own" — same "capability is
   *   generic, a stricter per-person rule would need service-layer
   *   enforcement" precedent as `BranchFundingService`) and by
   *   ADMIN/SUPERADMIN (who review+approve everything).
   * - APPROVE_MANAGER: [approve, approve] — deliberately `approveCapability`
   *   for BOTH steps (not `reviewCapability`), since MANAGER never holds
   *   approve capability for anything — this structurally excludes every
   *   Manager (including the applicant) from either step, leaving only
   *   ADMIN/SUPERADMIN/APPROVER, and the engine's own "same actor can't act
   *   twice" rule guarantees the two steps land on different people.
   * - APPROVE_ADMIN: [review, approve] — identical capability shape to
   *   APPROVE_STAFF (both held by ADMIN/SUPERADMIN); the distinguishing
   *   thing is simply which applicants get routed here (Admin/SuperAdmin),
   *   combined with the engine's maker-can't-act-on-own-request guard.
   */
  async onModuleInit(): Promise<void> {
    await this.workflowEngineService.registerChainConfig({
      entityType: WorkflowEntityType.LEAVE_APPLICATION,
      action: LeaveChainAction.APPROVE_STAFF,
      restartOnReturn: true,
      steps: [
        { order: 0, requiredCapability: reviewCapability(WorkflowEntityType.LEAVE_APPLICATION) },
        { order: 1, requiredCapability: approveCapability(WorkflowEntityType.LEAVE_APPLICATION) },
      ],
    });
    await this.workflowEngineService.registerChainConfig({
      entityType: WorkflowEntityType.LEAVE_APPLICATION,
      action: LeaveChainAction.APPROVE_MANAGER,
      restartOnReturn: true,
      steps: [
        { order: 0, requiredCapability: approveCapability(WorkflowEntityType.LEAVE_APPLICATION) },
        { order: 1, requiredCapability: approveCapability(WorkflowEntityType.LEAVE_APPLICATION) },
      ],
    });
    await this.workflowEngineService.registerChainConfig({
      entityType: WorkflowEntityType.LEAVE_APPLICATION,
      action: LeaveChainAction.APPROVE_ADMIN,
      restartOnReturn: true,
      steps: [
        { order: 0, requiredCapability: reviewCapability(WorkflowEntityType.LEAVE_APPLICATION) },
        { order: 1, requiredCapability: approveCapability(WorkflowEntityType.LEAVE_APPLICATION) },
      ],
    });
  }

  /** Calendar-days-inclusive of both endpoints, per assumption §1 — see PHASE_12_NOTES.md. */
  private computeNumberOfDays(startDate: Date, endDate: Date): number {
    const days = Math.round((endDate.getTime() - startDate.getTime()) / MS_PER_DAY) + 1;
    if (days <= 0) {
      throw new BadRequestException('endDate must be on or after startDate');
    }
    return days;
  }

  private async selectChainAction(staff: StaffDocument): Promise<LeaveChainAction> {
    if (staff.role === StaffRole.ADMIN || staff.role === StaffRole.SUPERADMIN) {
      return LeaveChainAction.APPROVE_ADMIN;
    }
    // Only ever relevant for MANAGER — MARKETER/APPROVER can never be a
    // branch's assigned manager (assignManager itself restricts assignment
    // to role === MANAGER — see BranchManagerAssignmentService).
    const currentManager = await this.branchManagerAssignmentService.getCurrentManager(
      staff.branchId.toString(),
    );
    if (currentManager && currentManager.staffId.toString() === staff._id.toString()) {
      return LeaveChainAction.APPROVE_MANAGER;
    }
    return LeaveChainAction.APPROVE_STAFF;
  }

  async applyForLeave(
    staffId: string,
    leaveTypeId: string,
    startDate: Date,
    endDate: Date,
    reason: string,
    initiatedBy: string,
  ): Promise<LeaveApplicationDocument> {
    const staff = await this.staffService.findById(staffId);
    if (staff.status !== StaffStatus.ACTIVE) {
      throw new BadRequestException(
        `Staff ${staffId} is not ACTIVE (status: ${staff.status}) and cannot apply for leave`,
      );
    }

    const numberOfDays = this.computeNumberOfDays(startDate, endDate);
    const year = startDate.getUTCFullYear();

    // Insufficient balance never blocks submission (assumption §2) — only flagged.
    const summary = await this.leaveBalanceService.getSummary(staffId, leaveTypeId, year);
    const shortfallDays = numberOfDays - summary.remainingDays;
    const balanceShortfallFlagged = shortfallDays > 0;

    const chainAction = await this.selectChainAction(staff);

    const application = await this.leaveApplicationModel.create({
      staffId: new Types.ObjectId(staffId),
      leaveTypeId: new Types.ObjectId(leaveTypeId),
      startDate,
      endDate,
      numberOfDays,
      reason,
      status: LeaveApplicationStatus.PENDING_REVIEW,
      appliedAt: new Date(),
      balanceApplied: false,
      chainAction,
      balanceShortfallFlagged,
      balanceShortfallDays: balanceShortfallFlagged ? shortfallDays : null,
    });

    await this.workflowEngineService.initiate({
      entityType: WorkflowEntityType.LEAVE_APPLICATION,
      action: chainAction,
      payload: { leaveApplicationId: application._id.toString() },
      initiatedBy,
      branchId: staff.branchId.toString(),
      entityId: application._id.toString(),
    });

    return application;
  }

  @OnEvent(WORKFLOW_APPROVED_EVENT)
  async handleWorkflowApproved(event: WorkflowApprovedEvent): Promise<void> {
    if ((event.entityType as WorkflowEntityType) !== WorkflowEntityType.LEAVE_APPLICATION) {
      return;
    }
    if (!event.entityId) {
      return; // defensive — LeaveApplication is always created with an entityId already set.
    }
    await this.leaveApplicationModel
      .updateOne({ _id: event.entityId }, { $set: { status: LeaveApplicationStatus.APPROVED } })
      .exec();
    // Idempotent — see LeaveBalanceService.applyUsage's own doc comment.
    await this.leaveBalanceService.applyUsage(event.entityId);
  }

  @OnEvent(WORKFLOW_REJECTED_EVENT)
  async handleWorkflowRejected(event: WorkflowRejectedEvent): Promise<void> {
    if ((event.entityType as WorkflowEntityType) !== WorkflowEntityType.LEAVE_APPLICATION) {
      return;
    }
    if (!event.entityId) {
      return;
    }
    await this.leaveApplicationModel
      .updateOne({ _id: event.entityId }, { $set: { status: LeaveApplicationStatus.REJECTED } })
      .exec();
  }

  /**
   * PENDING_REVIEW/PENDING_APPROVAL: the applicant themselves, or anyone
   * holding `LEAVE_CANCEL_APPROVED_CAPABILITY`, can withdraw a not-yet-
   * decided request — no balance effect, nothing was ever applied.
   *
   * APPROVED: requires `LEAVE_CANCEL_APPROVED_CAPABILITY` (ADMIN/SUPERADMIN)
   * regardless of who the applicant is — an applicant shouldn't be able to
   * unilaterally undo already-approved leave (assumption, flagged in
   * PHASE_12_NOTES.md). Reverses the balance application via the same
   * idempotent-guard pattern as `applyUsage` — a concurrent double-cancel
   * reverses exactly once.
   */
  async cancelApplication(
    applicationId: string,
    actor: LeaveActor,
  ): Promise<LeaveApplicationDocument> {
    const application = await this.leaveApplicationModel.findById(applicationId).exec();
    if (!application) {
      throw new NotFoundException(`LeaveApplication ${applicationId} not found`);
    }

    const hasAdminCancelCapability = actor.capabilities.includes(LEAVE_CANCEL_APPROVED_CAPABILITY);
    const isApplicant = application.staffId.toString() === actor.staffId;

    if (
      application.status === LeaveApplicationStatus.PENDING_REVIEW ||
      application.status === LeaveApplicationStatus.PENDING_APPROVAL
    ) {
      if (!isApplicant && !hasAdminCancelCapability) {
        throw new ForbiddenException(
          'Only the applicant or an Admin/SuperAdmin can cancel a pending leave application',
        );
      }
      const updated = await this.leaveApplicationModel
        .findOneAndUpdate(
          {
            _id: applicationId,
            status: {
              $in: [LeaveApplicationStatus.PENDING_REVIEW, LeaveApplicationStatus.PENDING_APPROVAL],
            },
          },
          { $set: { status: LeaveApplicationStatus.CANCELLED } },
          { new: true },
        )
        .exec();
      if (!updated) {
        throw new ConflictException(
          `LeaveApplication ${applicationId} was concurrently modified — retry`,
        );
      }
      await this.auditService.record({
        actorId: actor.staffId,
        action: 'LEAVE_APPLICATION_CANCELLED',
        entityType: 'LEAVE_APPLICATION',
        entityId: applicationId,
        after: { status: LeaveApplicationStatus.CANCELLED, wasApproved: false },
      });
      return updated;
    }

    if (application.status === LeaveApplicationStatus.APPROVED) {
      if (!hasAdminCancelCapability) {
        throw new ForbiddenException(
          'Cancelling an already-approved leave application requires Admin/SuperAdmin capability',
        );
      }
      const updated = await this.leaveApplicationModel
        .findOneAndUpdate(
          { _id: applicationId, status: LeaveApplicationStatus.APPROVED },
          { $set: { status: LeaveApplicationStatus.CANCELLED } },
          { new: true },
        )
        .exec();
      if (!updated) {
        throw new ConflictException(
          `LeaveApplication ${applicationId} was concurrently modified — retry`,
        );
      }
      await this.leaveBalanceService.reverseUsage(applicationId);
      await this.auditService.record({
        actorId: actor.staffId,
        action: 'LEAVE_APPLICATION_CANCELLED',
        entityType: 'LEAVE_APPLICATION',
        entityId: applicationId,
        after: { status: LeaveApplicationStatus.CANCELLED, wasApproved: true },
      });
      return updated;
    }

    throw new ConflictException(
      `LeaveApplication ${applicationId} cannot be cancelled from status ${application.status}`,
    );
  }

  async findByIdOrThrow(id: string): Promise<LeaveApplicationDocument> {
    const application = await this.leaveApplicationModel.findById(id).exec();
    if (!application) {
      throw new NotFoundException(`LeaveApplication ${id} not found`);
    }
    return application;
  }

  async findForStaff(staffId: string): Promise<LeaveApplicationDocument[]> {
    // Explicit cast — see LeaveBalanceService's own comment on why (Phase 11 bug).
    return this.leaveApplicationModel
      .find({ staffId: new Types.ObjectId(staffId) })
      .sort({ appliedAt: -1 })
      .exec();
  }
}
