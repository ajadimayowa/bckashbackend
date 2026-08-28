import { CustomerStatus, KycStatus } from '../../../common/enums/customer.enums';
import { CustomerDocument, EditPrivilegeStatus, Guarantor, CustomerReference, NextOfKin } from '../schemas/customer.schema';

/** Whitelisted view of Customer.editPrivilege — `signatureImageKey` is deliberately omitted, same reasoning as biometricImageKey/idDocumentImageKey never appearing here (a signed URL is fetched separately, see GET :id/edit-privilege/signature-url). */
export class EditPrivilegeResponseDto {
  status!: EditPrivilegeStatus;
  reason!: string | null;
  requestedBy!: string | null;
  requestedAt!: Date | null;
  decidedBy!: string | null;
  decidedAt!: Date | null;
  decisionComment!: string | null;
}

/**
 * Explicit field whitelist, same defense-in-depth pattern as
 * identity/dto/staff-response.dto.ts's StaffResponseDto — Customer itself
 * doesn't carry ciphertext (that's on KycRecord), but keeping this mapper
 * means a future field added to the schema doesn't leak through the API by
 * default.
 */
export class CustomerResponseDto {
  id!: string;
  firstName!: string;
  lastName!: string;
  phoneNumber!: string;
  email!: string | null;
  address!: string | null;
  branchId!: string;
  /** Resolved via CustomerService.resolveBranchNames — null only if the branch itself no longer exists. */
  branchName!: string | null;
  status!: CustomerStatus;
  kycStatus!: KycStatus;
  createdBy!: string;
  disabledReason!: string | null;
  disabledBy!: string | null;
  disabledAt!: Date | null;
  nextOfKin!: NextOfKin | null;
  guarantors!: Guarantor[];
  reference!: CustomerReference | null;
  editPrivilege!: EditPrivilegeResponseDto;
  /** The (approved) group this customer currently belongs to, if any — resolved via CustomerService.resolveGroupNames. */
  groupName!: string | null;
  createdAt!: Date;

  static fromDocument(
    doc: CustomerDocument,
    enrichment?: { branchName?: string | null; groupName?: string | null },
  ): CustomerResponseDto {
    const dto = new CustomerResponseDto();
    dto.id = doc._id.toString();
    dto.firstName = doc.firstName;
    dto.lastName = doc.lastName;
    dto.phoneNumber = doc.phoneNumber;
    dto.email = doc.email;
    dto.address = doc.address;
    dto.branchId = doc.branchId.toString();
    dto.branchName = enrichment?.branchName ?? null;
    dto.status = doc.status;
    dto.kycStatus = doc.kycStatus;
    dto.createdBy = doc.createdBy.toString();
    dto.disabledReason = doc.disabledReason;
    dto.disabledBy = doc.disabledBy ? doc.disabledBy.toString() : null;
    dto.disabledAt = doc.disabledAt;
    dto.nextOfKin = doc.nextOfKin;
    dto.guarantors = doc.guarantors;
    dto.reference = doc.reference;
    dto.editPrivilege = {
      status: doc.editPrivilege.status,
      reason: doc.editPrivilege.reason,
      requestedBy: doc.editPrivilege.requestedBy ? doc.editPrivilege.requestedBy.toString() : null,
      requestedAt: doc.editPrivilege.requestedAt,
      decidedBy: doc.editPrivilege.decidedBy ? doc.editPrivilege.decidedBy.toString() : null,
      decidedAt: doc.editPrivilege.decidedAt,
      decisionComment: doc.editPrivilege.decisionComment,
    };
    dto.groupName = enrichment?.groupName ?? null;
    dto.createdAt = doc.createdAt;
    return dto;
  }
}
