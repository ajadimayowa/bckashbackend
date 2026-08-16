import { ModuleName, StaffRole, StaffStatus } from '../../../common/enums/identity.enums';
import { StaffDocument } from '../schemas/staff.schema';

/**
 * The only shape a Staff document is ever allowed to leave this module as.
 * Built with an explicit field whitelist rather than "the document minus
 * passwordHash" — so a new sensitive field added to the schema later doesn't
 * automatically leak through the API by default; it has to be added here on
 * purpose.
 */
export class StaffResponseDto {
  id!: string;
  firstName!: string;
  lastName!: string;
  email!: string;
  phoneNumber!: string;
  role!: StaffRole;
  departmentId!: string;
  unitId!: string;
  branchId!: string;
  moduleAccess!: ModuleName[];
  status!: StaffStatus;
  disabledReason!: string | null;
  disabledBy!: string | null;
  disabledAt!: Date | null;
  createdAt!: Date;

  static fromDocument(doc: StaffDocument): StaffResponseDto {
    const dto = new StaffResponseDto();
    dto.id = doc._id.toString();
    dto.firstName = doc.firstName;
    dto.lastName = doc.lastName;
    dto.email = doc.email;
    dto.phoneNumber = doc.phoneNumber;
    dto.role = doc.role;
    dto.departmentId = doc.departmentId.toString();
    dto.unitId = doc.unitId.toString();
    dto.branchId = doc.branchId.toString();
    dto.moduleAccess = doc.moduleAccess;
    dto.status = doc.status;
    dto.disabledReason = doc.disabledReason;
    dto.disabledBy = doc.disabledBy ? doc.disabledBy.toString() : null;
    dto.disabledAt = doc.disabledAt;
    dto.createdAt = doc.createdAt;
    return dto;
  }
}
