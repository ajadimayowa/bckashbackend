import { BadRequestException, ForbiddenException } from '@nestjs/common';

import { StaffRole, StaffStatus } from '../../common/enums/identity.enums';
import { LeaveApplicationStatus, LeaveChainAction } from '../../common/enums/hr.enums';
import { WorkflowEntityType, WorkflowStepAction } from '../../common/enums/workflow.enums';
import {
  actOnWorkflow,
  approveLeaveActor,
  clearHrTestState,
  createBranch,
  createHrTestContext,
  createLeaveType,
  createStaffMember,
  HrTestContext,
  reviewLeaveActor,
  teardownHrTestContext,
} from './test-support/hr-test-context';

describe('LeaveApplicationService', () => {
  let ctx: HrTestContext;

  beforeAll(async () => {
    ctx = await createHrTestContext();
  }, 60_000);

  afterEach(async () => {
    await clearHrTestState(ctx);
  });

  afterAll(async () => {
    await teardownHrTestContext(ctx);
  });

  function tomorrow(offsetDays = 0): Date {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + 1 + offsetDays);
    return d;
  }

  describe('applyForLeave', () => {
    it('blocks a disabled staff member outright, before any workflow interaction', async () => {
      const branchId = await createBranch(ctx);
      const leaveType = await createLeaveType(ctx);
      const staff = await createStaffMember(ctx, branchId, { status: StaffStatus.DISABLED });

      await expect(
        ctx.leaveApplicationService.applyForLeave(
          staff._id.toString(),
          leaveType._id.toString(),
          tomorrow(),
          tomorrow(2),
          'Vacation',
          staff._id.toString(),
        ),
      ).rejects.toThrow(BadRequestException);

      const requestCount = await ctx.workflowRequestModel.countDocuments({}).exec();
      expect(requestCount).toBe(0);
    });

    it('computes numberOfDays as calendar-days-inclusive of both endpoints', async () => {
      const branchId = await createBranch(ctx);
      const leaveType = await createLeaveType(ctx);
      const staff = await createStaffMember(ctx, branchId, { role: StaffRole.MARKETER });
      const start = tomorrow();
      const end = tomorrow(2); // 3 calendar days inclusive: day0, day1, day2

      const application = await ctx.leaveApplicationService.applyForLeave(
        staff._id.toString(),
        leaveType._id.toString(),
        start,
        end,
        'Vacation',
        staff._id.toString(),
      );

      expect(application.numberOfDays).toBe(3);
    });

    describe('chain selection', () => {
      it('routes a regular staff applicant (MARKETER) through LEAVE_APPLICATION/APPROVE_STAFF', async () => {
        const branchId = await createBranch(ctx);
        const leaveType = await createLeaveType(ctx);
        const marketer = await createStaffMember(ctx, branchId, { role: StaffRole.MARKETER });

        const application = await ctx.leaveApplicationService.applyForLeave(
          marketer._id.toString(),
          leaveType._id.toString(),
          tomorrow(),
          tomorrow(1),
          'Vacation',
          marketer._id.toString(),
        );

        expect(application.chainAction).toBe(LeaveChainAction.APPROVE_STAFF);
        const workflowRequest = await ctx.workflowRequestModel
          .findOne({ entityId: application._id.toString() })
          .exec();
        expect(workflowRequest!.chainConfigRef).toBe(
          `${WorkflowEntityType.LEAVE_APPLICATION}:${LeaveChainAction.APPROVE_STAFF}`,
        );
      });

      it("routes the current Branch Manager's own application through LEAVE_APPLICATION/APPROVE_MANAGER", async () => {
        const branchId = await createBranch(ctx);
        const leaveType = await createLeaveType(ctx);
        const manager = await createStaffMember(ctx, branchId, { role: StaffRole.MANAGER });
        const admin = await createStaffMember(ctx, branchId, { role: StaffRole.ADMIN });
        await ctx.branchManagerAssignmentService.assignManager(
          branchId,
          manager._id.toString(),
          admin._id.toString(),
        );

        const application = await ctx.leaveApplicationService.applyForLeave(
          manager._id.toString(),
          leaveType._id.toString(),
          tomorrow(),
          tomorrow(1),
          'Vacation',
          manager._id.toString(),
        );

        expect(application.chainAction).toBe(LeaveChainAction.APPROVE_MANAGER);
      });

      it('routes a Manager who is NOT the current branch manager through APPROVE_STAFF (not APPROVE_MANAGER)', async () => {
        const branchId = await createBranch(ctx);
        const leaveType = await createLeaveType(ctx);
        // No manager assigned to this branch at all.
        const manager = await createStaffMember(ctx, branchId, { role: StaffRole.MANAGER });

        const application = await ctx.leaveApplicationService.applyForLeave(
          manager._id.toString(),
          leaveType._id.toString(),
          tomorrow(),
          tomorrow(1),
          'Vacation',
          manager._id.toString(),
        );

        expect(application.chainAction).toBe(LeaveChainAction.APPROVE_STAFF);
      });

      it('routes an Admin/SuperAdmin applicant through LEAVE_APPLICATION/APPROVE_ADMIN', async () => {
        const branchId = await createBranch(ctx);
        const leaveType = await createLeaveType(ctx);
        const admin = await createStaffMember(ctx, branchId, { role: StaffRole.ADMIN });

        const application = await ctx.leaveApplicationService.applyForLeave(
          admin._id.toString(),
          leaveType._id.toString(),
          tomorrow(),
          tomorrow(1),
          'Vacation',
          admin._id.toString(),
        );

        expect(application.chainAction).toBe(LeaveChainAction.APPROVE_ADMIN);
      });
    });

    it('a Branch Manager applying for their own leave never has themselves as a required reviewer at any step', async () => {
      const branchId = await createBranch(ctx);
      const leaveType = await createLeaveType(ctx);
      const manager = await createStaffMember(ctx, branchId, { role: StaffRole.MANAGER });
      const admin1 = await createStaffMember(ctx, branchId, { role: StaffRole.ADMIN });
      const admin2 = await createStaffMember(ctx, branchId, { role: StaffRole.ADMIN });
      await ctx.branchManagerAssignmentService.assignManager(
        branchId,
        manager._id.toString(),
        admin1._id.toString(),
      );

      const application = await ctx.leaveApplicationService.applyForLeave(
        manager._id.toString(),
        leaveType._id.toString(),
        tomorrow(),
        tomorrow(1),
        'Vacation',
        manager._id.toString(),
      );
      const workflowRequestId = (await ctx.workflowRequestModel
        .findOne({ entityId: application._id.toString() })
        .exec())!._id.toString();

      // The engine's own "maker can't act on own request" guard should
      // reject the manager trying to act on their own application,
      // structurally proving they were never a viable reviewer.
      await expect(
        actOnWorkflow(ctx, workflowRequestId, approveLeaveActor(manager._id.toString())),
      ).rejects.toThrow(ForbiddenException);

      // And the chain's actual steps require approveCapability (admin-tier
      // only) — a plain review-capability actor (a generic Manager) cannot
      // act on this chain at all, confirming no manager-review step exists.
      await expect(
        actOnWorkflow(ctx, workflowRequestId, reviewLeaveActor(admin2._id.toString())),
      ).rejects.toThrow(ForbiddenException);

      // A different Admin succeeds.
      await actOnWorkflow(ctx, workflowRequestId, approveLeaveActor(admin2._id.toString()));
      const afterStep0 = await ctx.workflowRequestModel.findById(workflowRequestId).exec();
      expect(afterStep0!.currentStepIndex).toBe(1);
    });

    it('does not block submission when numberOfDays exceeds the remaining balance, but flags the shortfall', async () => {
      const branchId = await createBranch(ctx);
      const leaveType = await createLeaveType(ctx, { defaultAnnualAllocationDays: 2 });
      const staff = await createStaffMember(ctx, branchId, { role: StaffRole.MARKETER });

      const application = await ctx.leaveApplicationService.applyForLeave(
        staff._id.toString(),
        leaveType._id.toString(),
        tomorrow(),
        tomorrow(4), // 5 calendar days, only 2 allocated
        'Vacation',
        staff._id.toString(),
      );

      expect(application.status).toBe(LeaveApplicationStatus.PENDING_REVIEW);
      expect(application.balanceShortfallFlagged).toBe(true);
      expect(application.balanceShortfallDays).toBe(3);
    });

    it('does not flag a shortfall when the balance covers the requested days', async () => {
      const branchId = await createBranch(ctx);
      const leaveType = await createLeaveType(ctx, { defaultAnnualAllocationDays: 20 });
      const staff = await createStaffMember(ctx, branchId, { role: StaffRole.MARKETER });

      const application = await ctx.leaveApplicationService.applyForLeave(
        staff._id.toString(),
        leaveType._id.toString(),
        tomorrow(),
        tomorrow(1),
        'Vacation',
        staff._id.toString(),
      );

      expect(application.balanceShortfallFlagged).toBe(false);
      expect(application.balanceShortfallDays).toBeNull();
    });
  });

  describe('balance application on approval', () => {
    async function raiseAndApprove(ctx: HrTestContext, branchId: string, leaveTypeId: string) {
      const staff = await createStaffMember(ctx, branchId, { role: StaffRole.MARKETER });
      const manager = await createStaffMember(ctx, branchId, { role: StaffRole.MANAGER });
      const admin = await createStaffMember(ctx, branchId, { role: StaffRole.ADMIN });
      await ctx.branchManagerAssignmentService.assignManager(
        branchId,
        manager._id.toString(),
        admin._id.toString(),
      );
      const application = await ctx.leaveApplicationService.applyForLeave(
        staff._id.toString(),
        leaveTypeId,
        tomorrow(),
        tomorrow(2),
        'Vacation',
        staff._id.toString(),
      );
      const workflowRequestId = (await ctx.workflowRequestModel
        .findOne({ entityId: application._id.toString() })
        .exec())!._id.toString();
      await actOnWorkflow(ctx, workflowRequestId, reviewLeaveActor(manager._id.toString()));
      await actOnWorkflow(ctx, workflowRequestId, approveLeaveActor(admin._id.toString()));
      return { staff, application };
    }

    it('applies usedDays exactly once, idempotent under a simulated double-fire of workflow.approved', async () => {
      const branchId = await createBranch(ctx);
      const leaveType = await createLeaveType(ctx);
      const { staff, application } = await raiseAndApprove(ctx, branchId, leaveType._id.toString());

      const reloaded = await ctx.leaveApplicationModel.findById(application._id).exec();
      expect(reloaded!.status).toBe(LeaveApplicationStatus.APPROVED);
      expect(reloaded!.balanceApplied).toBe(true);

      // Simulate a duplicate fire directly against the idempotent applier.
      const secondApply = await ctx.leaveBalanceService.applyUsage(application._id.toString());
      expect(secondApply).toBe(false); // already applied — no-op

      const year = new Date().getUTCFullYear();
      const summary = await ctx.leaveBalanceService.getSummary(
        staff._id.toString(),
        leaveType._id.toString(),
        year,
      );
      expect(summary.usedDays).toBe(application.numberOfDays); // not double-counted
    });

    it('sets status REJECTED with no balance effect on workflow rejection', async () => {
      const branchId = await createBranch(ctx);
      const leaveType = await createLeaveType(ctx);
      const staff = await createStaffMember(ctx, branchId, { role: StaffRole.MARKETER });
      const manager = await createStaffMember(ctx, branchId, { role: StaffRole.MANAGER });
      const application = await ctx.leaveApplicationService.applyForLeave(
        staff._id.toString(),
        leaveType._id.toString(),
        tomorrow(),
        tomorrow(1),
        'Vacation',
        staff._id.toString(),
      );
      const workflowRequestId = (await ctx.workflowRequestModel
        .findOne({ entityId: application._id.toString() })
        .exec())!._id.toString();
      await actOnWorkflow(
        ctx,
        workflowRequestId,
        reviewLeaveActor(manager._id.toString()),
        WorkflowStepAction.REJECTED,
      );

      const reloaded = await ctx.leaveApplicationModel.findById(application._id).exec();
      expect(reloaded!.status).toBe(LeaveApplicationStatus.REJECTED);
      expect(reloaded!.balanceApplied).toBe(false);

      const year = new Date().getUTCFullYear();
      const summary = await ctx.leaveBalanceService.getSummary(
        staff._id.toString(),
        leaveType._id.toString(),
        year,
      );
      expect(summary.usedDays).toBe(0);
    });
  });

  describe('cancelApplication', () => {
    it('cancelling a PENDING_REVIEW application has no balance effect', async () => {
      const branchId = await createBranch(ctx);
      const leaveType = await createLeaveType(ctx);
      const staff = await createStaffMember(ctx, branchId, { role: StaffRole.MARKETER });
      const application = await ctx.leaveApplicationService.applyForLeave(
        staff._id.toString(),
        leaveType._id.toString(),
        tomorrow(),
        tomorrow(1),
        'Vacation',
        staff._id.toString(),
      );

      const cancelled = await ctx.leaveApplicationService.cancelApplication(
        application._id.toString(),
        { staffId: staff._id.toString(), capabilities: [] },
      );

      expect(cancelled.status).toBe(LeaveApplicationStatus.CANCELLED);
      const year = new Date().getUTCFullYear();
      const summary = await ctx.leaveBalanceService.getSummary(
        staff._id.toString(),
        leaveType._id.toString(),
        year,
      );
      expect(summary.usedDays).toBe(0);
    });

    it('cancelling an APPROVED application without the Admin/SuperAdmin capability is rejected', async () => {
      const branchId = await createBranch(ctx);
      const leaveType = await createLeaveType(ctx);
      const staff = await createStaffMember(ctx, branchId, { role: StaffRole.MARKETER });
      const manager = await createStaffMember(ctx, branchId, { role: StaffRole.MANAGER });
      const admin = await createStaffMember(ctx, branchId, { role: StaffRole.ADMIN });
      const application = await ctx.leaveApplicationService.applyForLeave(
        staff._id.toString(),
        leaveType._id.toString(),
        tomorrow(),
        tomorrow(1),
        'Vacation',
        staff._id.toString(),
      );
      const workflowRequestId = (await ctx.workflowRequestModel
        .findOne({ entityId: application._id.toString() })
        .exec())!._id.toString();
      await actOnWorkflow(ctx, workflowRequestId, reviewLeaveActor(manager._id.toString()));
      await actOnWorkflow(ctx, workflowRequestId, approveLeaveActor(admin._id.toString()));

      await expect(
        ctx.leaveApplicationService.cancelApplication(application._id.toString(), {
          staffId: staff._id.toString(), // the applicant themselves — not admin-capable
          capabilities: [],
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('cancelling an APPROVED application with the Admin/SuperAdmin capability correctly and atomically reverses the balance exactly once', async () => {
      const branchId = await createBranch(ctx);
      const leaveType = await createLeaveType(ctx);
      const staff = await createStaffMember(ctx, branchId, { role: StaffRole.MARKETER });
      const manager = await createStaffMember(ctx, branchId, { role: StaffRole.MANAGER });
      const admin = await createStaffMember(ctx, branchId, { role: StaffRole.ADMIN });
      const application = await ctx.leaveApplicationService.applyForLeave(
        staff._id.toString(),
        leaveType._id.toString(),
        tomorrow(),
        tomorrow(1),
        'Vacation',
        staff._id.toString(),
      );
      const workflowRequestId = (await ctx.workflowRequestModel
        .findOne({ entityId: application._id.toString() })
        .exec())!._id.toString();
      await actOnWorkflow(ctx, workflowRequestId, reviewLeaveActor(manager._id.toString()));
      await actOnWorkflow(ctx, workflowRequestId, approveLeaveActor(admin._id.toString()));

      const year = new Date().getUTCFullYear();
      const beforeCancel = await ctx.leaveBalanceService.getSummary(
        staff._id.toString(),
        leaveType._id.toString(),
        year,
      );
      expect(beforeCancel.usedDays).toBe(application.numberOfDays);

      // Concurrent double-cancel — only one should actually reverse.
      const actor = { staffId: admin._id.toString(), capabilities: ['leave:cancel_approved'] };
      const [a, b] = await Promise.allSettled([
        ctx.leaveApplicationService.cancelApplication(application._id.toString(), actor),
        ctx.leaveApplicationService.cancelApplication(application._id.toString(), actor),
      ]);
      // Exactly one must succeed (the other hits the status-guard ConflictException).
      const fulfilled = [a, b].filter((r) => r.status === 'fulfilled');
      expect(fulfilled).toHaveLength(1);

      const afterCancel = await ctx.leaveBalanceService.getSummary(
        staff._id.toString(),
        leaveType._id.toString(),
        year,
      );
      expect(afterCancel.usedDays).toBe(0);
      const reloaded = await ctx.leaveApplicationModel.findById(application._id).exec();
      expect(reloaded!.status).toBe(LeaveApplicationStatus.CANCELLED);
      expect(reloaded!.balanceApplied).toBe(false);
    });
  });
});
