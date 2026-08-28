import {
  Gender,
  IdentificationType,
  ModuleName,
  StaffEmploymentType,
  StaffRole,
  StaffStatus,
  StaffUserType,
} from '../../../common/enums/identity.enums';
import { StaffDocument } from '../schemas/staff.schema';

export class ContactPersonResponseDto {
  name!: string | null;
  relationship!: string | null;
  phoneNumber!: string | null;
  address!: string | null;
}

export class ResidentialAddressResponseDto {
  state!: string | null;
  city!: string | null;
  street!: string | null;
}

export class KycResponseDto {
  dateOfBirth!: Date | null;
  gender!: Gender | null;
  idType!: IdentificationType | null;
  idNumber!: string | null;
}

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
  userType!: StaffUserType;
  departmentId!: string;
  unitId!: string;
  branchId!: string;
  moduleAccess!: ModuleName[];
  status!: StaffStatus;
  disabledReason!: string | null;
  disabledBy!: string | null;
  disabledAt!: Date | null;
  /** Non-sensitive — the encrypted BVN itself (`bvnEncrypted`) is deliberately never exposed here. */
  bvnVerified!: boolean;
  bvnVerifiedAt!: Date | null;
  /** Lets a frontend show a "please change your password" banner — see Staff schema's own comment. */
  mustChangePassword!: boolean;
  startDate!: Date | null;
  residentialAddress!: ResidentialAddressResponseDto | null;
  kyc!: KycResponseDto | null;
  nextOfKin!: ContactPersonResponseDto | null;
  reference!: ContactPersonResponseDto | null;
  passportPhotoUrl!: string | null;
  idDocumentUrl!: string | null;
  employmentType!: StaffEmploymentType | null;
  salaryGrade!: string | null;
  /** Another Staff's id, or null — resolve the name client-side against the staff list, same convention as departmentId/unitId/branchId. */
  managerId!: string | null;
  lastLoginAt!: Date | null;
  ninVerified!: boolean;
  guarantorFormVerified!: boolean;
  offerLetterVerified!: boolean;
  createdAt!: Date;

  static fromDocument(doc: StaffDocument): StaffResponseDto {
    const dto = new StaffResponseDto();
    dto.id = doc._id.toString();
    dto.firstName = doc.firstName;
    dto.lastName = doc.lastName;
    dto.email = doc.email;
    dto.phoneNumber = doc.phoneNumber;
    dto.role = doc.role;
    dto.userType = doc.userType;
    dto.departmentId = doc.departmentId.toString();
    dto.unitId = doc.unitId.toString();
    dto.branchId = doc.branchId.toString();
    dto.moduleAccess = doc.moduleAccess;
    dto.status = doc.status;
    dto.disabledReason = doc.disabledReason;
    dto.disabledBy = doc.disabledBy ? doc.disabledBy.toString() : null;
    dto.disabledAt = doc.disabledAt;
    dto.bvnVerified = doc.bvnVerified;
    dto.bvnVerifiedAt = doc.bvnVerifiedAt;
    dto.mustChangePassword = doc.mustChangePassword;
    dto.startDate = doc.startDate;
    dto.residentialAddress = doc.residentialAddress
      ? {
          state: doc.residentialAddress.state,
          city: doc.residentialAddress.city,
          street: doc.residentialAddress.street,
        }
      : null;
    dto.kyc = doc.kyc
      ? {
          dateOfBirth: doc.kyc.dateOfBirth,
          gender: doc.kyc.gender,
          idType: doc.kyc.idType,
          idNumber: doc.kyc.idNumber,
        }
      : null;
    dto.nextOfKin = doc.nextOfKin
      ? {
          name: doc.nextOfKin.name,
          relationship: doc.nextOfKin.relationship,
          phoneNumber: doc.nextOfKin.phoneNumber,
          address: doc.nextOfKin.address,
        }
      : null;
    dto.reference = doc.reference
      ? {
          name: doc.reference.name,
          relationship: doc.reference.relationship,
          phoneNumber: doc.reference.phoneNumber,
          address: doc.reference.address,
        }
      : null;
    dto.passportPhotoUrl = doc.passportPhotoUrl;
    dto.idDocumentUrl = doc.idDocumentUrl;
    dto.employmentType = doc.employmentType;
    dto.salaryGrade = doc.salaryGrade;
    dto.managerId = doc.managerId ? doc.managerId.toString() : null;
    dto.lastLoginAt = doc.lastLoginAt;
    dto.ninVerified = doc.ninVerified;
    dto.guarantorFormVerified = doc.guarantorFormVerified;
    dto.offerLetterVerified = doc.offerLetterVerified;
    dto.createdAt = doc.createdAt;
    return dto;
  }
}
