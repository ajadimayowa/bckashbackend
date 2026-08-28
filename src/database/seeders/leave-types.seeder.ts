import { INestApplicationContext, Logger } from '@nestjs/common';

import { LeaveTypeService } from '../../modules/hr/leave-type.service';

const logger = new Logger('LeaveTypesSeeder');

/**
 * `LeaveType` is fully admin-manageable data (Phase 12) — a fresh
 * deployment starts with *zero* leave types, meaning no staff member could
 * apply for anything until an Admin manually created some via
 * `POST /api/v1/hr/leave-types`. Seeds a sensible starting set (the exact
 * example names the Phase 12 brief itself used) so the system is usable
 * out of the box — Admins can still rename/deactivate/add more later, this
 * is a starting point, not a fixed taxonomy.
 *
 * Idempotent by name — only inserts a leave type whose name doesn't already
 * exist, so re-running never duplicates, and an Admin who's already renamed
 * or removed one of these isn't overwritten.
 */
export async function seedDefaultLeaveTypes(app: INestApplicationContext): Promise<void> {
  const leaveTypeService = app.get(LeaveTypeService);
  const existing = await leaveTypeService.findAll();
  const existingNames = new Set(existing.map((t) => t.name));

  const defaults: { name: string; defaultAnnualAllocationDays: number; paid: boolean }[] = [
    { name: 'Annual', defaultAnnualAllocationDays: 20, paid: true },
    { name: 'Sick', defaultAnnualAllocationDays: 10, paid: true },
    { name: 'Casual', defaultAnnualAllocationDays: 5, paid: true },
    { name: 'Maternity/Paternity', defaultAnnualAllocationDays: 90, paid: true },
    { name: 'Unpaid', defaultAnnualAllocationDays: 0, paid: false },
  ];

  for (const def of defaults) {
    if (existingNames.has(def.name)) {
      continue;
    }
    await leaveTypeService.create(def);
    logger.log(`Seeded default LeaveType: "${def.name}"`);
  }
}
