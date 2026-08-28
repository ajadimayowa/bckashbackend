import { INestApplicationContext, Logger } from '@nestjs/common';

import { BranchesService } from '../../modules/branches/branches.service';
import { DepartmentsService } from '../../modules/identity/departments.service';
import { UnitsService } from '../../modules/identity/units.service';

const logger = new Logger('OrgStructureSeeder');

export interface SeededOrgStructure {
  departmentId: string;
  unitId: string;
  branchId: string;
}

/**
 * Idempotent — only creates a Department/Unit/Branch when *none* exist yet
 * (checked by presence, not by name, so renaming the seeded defaults later
 * doesn't cause this to re-seed a duplicate). Exists so `seedSuperAdmin`
 * always has somewhere valid to point its required departmentId/unitId/
 * branchId — Staff's own schema requires all three, there's no "no
 * department yet" escape hatch.
 *
 * Named "Unassigned" (not a real business department like "Head Office")
 * per explicit product decision — this is bootstrap scaffolding for the
 * SuperAdmin account only, not meant to read as a real, pre-populated
 * department the org actually has. Rename/replace it via Settings once
 * real departments exist.
 */
export async function seedOrgStructure(app: INestApplicationContext): Promise<SeededOrgStructure> {
  const departmentsService = app.get(DepartmentsService);
  const unitsService = app.get(UnitsService);
  const branchesService = app.get(BranchesService);

  const existingDepartments = await departmentsService.findAll();
  const department =
    existingDepartments[0] ?? (await departmentsService.create({ name: 'Unassigned' }));
  if (existingDepartments.length === 0) {
    logger.log(`Seeded bootstrap Department: "${department.name}" (${department._id.toString()})`);
  }

  const existingUnits = await unitsService.findAll(department._id.toString());
  const unit =
    existingUnits[0] ??
    (await unitsService.create({
      departmentId: department._id.toString(),
      name: 'Unassigned',
    }));
  if (existingUnits.length === 0) {
    logger.log(`Seeded bootstrap Unit: "${unit.name}" (${unit._id.toString()})`);
  }

  const existingBranches = await branchesService.findAll();
  const branch =
    existingBranches[0] ??
    (await branchesService.createDirect({ name: 'Head Office Branch', code: 'HQ' }));
  if (existingBranches.length === 0) {
    logger.log(`Seeded default Branch: "${branch.name}" (${branch._id.toString()})`);
  }

  return {
    departmentId: department._id.toString(),
    unitId: unit._id.toString(),
    branchId: branch._id.toString(),
  };
}
