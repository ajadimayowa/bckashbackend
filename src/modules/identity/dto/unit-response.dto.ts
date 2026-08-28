import { UnitDocument } from '../schemas/unit.schema';

/**
 * Explicit field whitelist, same convention as StaffResponseDto —
 * `departmentName` is resolved by the caller (UnitsController, which has
 * DepartmentsService) and passed in; UnitsService itself keeps returning
 * bare `UnitDocument`s (org-structure.seeder.ts and others still depend on
 * that raw shape — see UnitsController for where the two get joined).
 */
export class UnitResponseDto {
  id!: string;
  name!: string;
  active!: boolean;
  departmentId!: string;
  departmentName!: string;
  /** Every Staff record currently pointing at this unit. Defaults to 0 when the caller doesn't pass one (see UnitsController's own doc comment on where it's computed). */
  staffCount!: number;
  createdAt!: Date;

  static fromDocument(doc: UnitDocument, departmentName: string, staffCount = 0): UnitResponseDto {
    const dto = new UnitResponseDto();
    dto.id = doc._id.toString();
    dto.name = doc.name;
    dto.active = doc.active;
    dto.departmentId = doc.departmentId.toString();
    dto.departmentName = departmentName;
    dto.staffCount = staffCount;
    dto.createdAt = doc.createdAt;
    return dto;
  }
}
