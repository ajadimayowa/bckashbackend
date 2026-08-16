import { CustomerStatus, KycStatus } from '../../../common/enums/customer.enums';
import { CustomerDocument } from '../schemas/customer.schema';

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
  status!: CustomerStatus;
  kycStatus!: KycStatus;
  createdBy!: string;
  createdAt!: Date;

  static fromDocument(doc: CustomerDocument): CustomerResponseDto {
    const dto = new CustomerResponseDto();
    dto.id = doc._id.toString();
    dto.firstName = doc.firstName;
    dto.lastName = doc.lastName;
    dto.phoneNumber = doc.phoneNumber;
    dto.email = doc.email;
    dto.address = doc.address;
    dto.branchId = doc.branchId.toString();
    dto.status = doc.status;
    dto.kycStatus = doc.kycStatus;
    dto.createdBy = doc.createdBy.toString();
    dto.createdAt = doc.createdAt;
    return dto;
  }
}
