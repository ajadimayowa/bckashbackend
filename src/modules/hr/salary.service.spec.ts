import { NotFoundException } from '@nestjs/common';

import { StaffRole } from '../../common/enums/identity.enums';
import { WorkflowStepAction } from '../../common/enums/workflow.enums';
import {
  actOnWorkflow,
  approveSalaryActor,
  clearHrTestState,
  createBranch,
  createHrTestContext,
  createStaffMember,
  HrTestContext,
  teardownHrTestContext,
} from './test-support/hr-test-context';

describe('SalaryService', () => {
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

  async function proposeAndApprove(
    ctx: HrTestContext,
    staffId: string,
    branchId: string,
    baseSalaryKobo: number,
    effectiveFrom: Date,
  ) {
    const admin1 = await createStaffMember(ctx, branchId, { role: StaffRole.ADMIN });
    const admin2 = await createStaffMember(ctx, branchId, { role: StaffRole.ADMIN });
    const request = await ctx.salaryService.proposeSalaryChange(
      staffId,
      baseSalaryKobo,
      [{ name: 'Housing', amountKobo: 5_000 }],
      effectiveFrom,
      admin1._id.toString(),
      branchId,
    );
    await actOnWorkflow(ctx, request._id.toString(), approveSalaryActor(admin2._id.toString()));
  }

  it('is not persisted until workflow.approved', async () => {
    const branchId = await createBranch(ctx);
    const staff = await createStaffMember(ctx, branchId, { role: StaffRole.MARKETER });
    const admin = await createStaffMember(ctx, branchId, { role: StaffRole.ADMIN });

    await ctx.salaryService.proposeSalaryChange(
      staff._id.toString(),
      500_000,
      [],
      new Date(),
      admin._id.toString(),
      branchId,
    );

    await expect(ctx.salaryService.getCurrentSalary(staff._id.toString())).rejects.toThrow(
      NotFoundException,
    );
  });

  it('creates the first SalaryRecord for a staff member with no prior record', async () => {
    const branchId = await createBranch(ctx);
    const staff = await createStaffMember(ctx, branchId, { role: StaffRole.MARKETER });
    const effectiveFrom = new Date('2026-01-01T00:00:00.000Z');

    await proposeAndApprove(ctx, staff._id.toString(), branchId, 500_000, effectiveFrom);

    const current = await ctx.salaryService.getCurrentSalary(staff._id.toString());
    expect(current.baseSalaryKobo).toBe(500_000);
    expect(current.allowances).toEqual([{ name: 'Housing', amountKobo: 5_000 }]);
    expect(current.effectiveTo).toBeNull();
  });

  it('a subsequent change correctly closes the prior active record (effectiveTo set) in the same transaction, and activates the new one', async () => {
    const branchId = await createBranch(ctx);
    const staff = await createStaffMember(ctx, branchId, { role: StaffRole.MARKETER });
    const firstEffectiveFrom = new Date('2026-01-01T00:00:00.000Z');
    const secondEffectiveFrom = new Date('2026-06-01T00:00:00.000Z');

    await proposeAndApprove(ctx, staff._id.toString(), branchId, 500_000, firstEffectiveFrom);
    await proposeAndApprove(ctx, staff._id.toString(), branchId, 600_000, secondEffectiveFrom);

    const current = await ctx.salaryService.getCurrentSalary(staff._id.toString());
    expect(current.baseSalaryKobo).toBe(600_000);
    expect(current.effectiveFrom.toISOString()).toBe(secondEffectiveFrom.toISOString());
    expect(current.effectiveTo).toBeNull();

    const history = await ctx.salaryService.getSalaryHistory(staff._id.toString());
    expect(history).toHaveLength(2);
    const closed = history.find((r) => r.baseSalaryKobo === 500_000);
    expect(closed!.effectiveTo?.toISOString()).toBe(secondEffectiveFrom.toISOString());

    // Only one active (effectiveTo: null) record at a time — the schema's own invariant.
    const activeCount = await ctx.salaryRecordModel
      .countDocuments({ staffId: staff._id, effectiveTo: null })
      .exec();
    expect(activeCount).toBe(1);
  });

  it('stores baseSalaryKobo/allowances encrypted at rest — the raw DB value is never plaintext — and decrypts correctly', async () => {
    const branchId = await createBranch(ctx);
    const staff = await createStaffMember(ctx, branchId, { role: StaffRole.MARKETER });
    await proposeAndApprove(ctx, staff._id.toString(), branchId, 750_000, new Date());

    const raw = await ctx.salaryRecordModel.findOne({ staffId: staff._id }).lean().exec();
    expect(raw!.baseSalaryKoboEncrypted).not.toContain('750000');
    expect(raw!.baseSalaryKoboEncrypted).not.toBe('750000');
    expect(raw!.allowancesEncrypted).not.toContain('Housing');
    // Ciphertext format: <iv>.<authTag>.<ciphertext>, all base64.
    expect(raw!.baseSalaryKoboEncrypted.split('.')).toHaveLength(3);

    const decrypted = await ctx.salaryService.getCurrentSalary(staff._id.toString());
    expect(decrypted.baseSalaryKobo).toBe(750_000);
    expect(decrypted.allowances).toEqual([{ name: 'Housing', amountKobo: 5_000 }]);
  });

  it('a different Admin/SuperAdmin must approve — the proposer cannot approve their own proposal', async () => {
    const branchId = await createBranch(ctx);
    const staff = await createStaffMember(ctx, branchId, { role: StaffRole.MARKETER });
    const admin = await createStaffMember(ctx, branchId, { role: StaffRole.ADMIN });

    const request = await ctx.salaryService.proposeSalaryChange(
      staff._id.toString(),
      500_000,
      [],
      new Date(),
      admin._id.toString(),
      branchId,
    );

    await expect(
      actOnWorkflow(
        ctx,
        request._id.toString(),
        approveSalaryActor(admin._id.toString()),
        WorkflowStepAction.APPROVED,
      ),
    ).rejects.toThrow(); // ForbiddenException — maker can't act on own request
  });
});
