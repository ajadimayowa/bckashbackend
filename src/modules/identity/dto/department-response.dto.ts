import { DepartmentDocument } from '../schemas/department.schema';

/**
 * Explicit field whitelist, same convention as UnitResponseDto/StaffResponseDto
 * — DepartmentsController previously returned bare DepartmentDocuments
 * (`_id`, not `id`), and had no `staffCount` at all (see
 * DepartmentsService.countStaff/countStaffByDepartment's own doc comment).
 */
export class DepartmentResponseDto {
  id!: string;
  name!: string;
  active!: boolean;
  /** Every Staff record currently pointing at this department. */
  staffCount!: number;
  createdAt!: Date;
  updatedAt!: Date;

  static fromDocument(doc: DepartmentDocument, staffCount: number): DepartmentResponseDto {
    const dto = new DepartmentResponseDto();
    dto.id = doc._id.toString();
    dto.name = doc.name;
    dto.active = doc.active;
    dto.staffCount = staffCount;
    dto.createdAt = doc.createdAt;
    dto.updatedAt = doc.updatedAt;
    return dto;
  }
}
