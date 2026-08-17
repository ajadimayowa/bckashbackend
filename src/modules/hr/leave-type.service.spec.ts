import { BadRequestException, NotFoundException } from '@nestjs/common';

import {
  clearHrTestState,
  createHrTestContext,
  HrTestContext,
  teardownHrTestContext,
} from './test-support/hr-test-context';

describe('LeaveTypeService', () => {
  let ctx: HrTestContext;

  beforeAll(async () => {
    ctx = await createHrTestContext();
  }, 60_000);

  afterEach(async () => {
    await clearHrTestState(ctx);
    await ctx.leaveTypeModel.deleteMany({}).exec();
  });

  afterAll(async () => {
    await teardownHrTestContext(ctx);
  });

  it('creates a leave type and enforces a unique name', async () => {
    await ctx.leaveTypeService.create({
      name: 'Annual',
      defaultAnnualAllocationDays: 20,
      paid: true,
    });

    await expect(
      ctx.leaveTypeService.create({ name: 'Annual', defaultAnnualAllocationDays: 10, paid: true }),
    ).rejects.toThrow(BadRequestException);
  });

  it('creates an "Unpaid" leave type with 0 default allocation, paid: false', async () => {
    const unpaid = await ctx.leaveTypeService.create({
      name: 'Unpaid',
      defaultAnnualAllocationDays: 0,
      paid: false,
    });
    expect(unpaid.defaultAnnualAllocationDays).toBe(0);
    expect(unpaid.paid).toBe(false);
    expect(unpaid.active).toBe(true);
  });

  it('updates a leave type', async () => {
    const created = await ctx.leaveTypeService.create({
      name: 'Sick',
      defaultAnnualAllocationDays: 10,
      paid: true,
    });

    const updated = await ctx.leaveTypeService.update(created._id.toString(), { active: false });
    expect(updated.active).toBe(false);
  });

  it('throws NotFoundException updating a non-existent leave type', async () => {
    await expect(
      ctx.leaveTypeService.update('64b000000000000000000000', { active: false }),
    ).rejects.toThrow(NotFoundException);
  });

  it('findAll(activeOnly=true) excludes inactive leave types', async () => {
    const active = await ctx.leaveTypeService.create({
      name: 'Casual',
      defaultAnnualAllocationDays: 5,
      paid: true,
    });
    const inactive = await ctx.leaveTypeService.create({
      name: 'Old Type',
      defaultAnnualAllocationDays: 5,
      paid: true,
    });
    await ctx.leaveTypeService.update(inactive._id.toString(), { active: false });

    const activeOnly = await ctx.leaveTypeService.findAll(true);
    const ids = activeOnly.map((t) => t._id.toString());
    expect(ids).toContain(active._id.toString());
    expect(ids).not.toContain(inactive._id.toString());
  });
});
