import { OrganisationAccountDetail, OrganisationDocument } from '../schemas/organisation.schema';

/**
 * Explicit field whitelist, same convention as StaffResponseDto — `cacDocKey`
 * (a raw S3 key) is deliberately never exposed; `cacDocUploaded` tells the
 * frontend whether one exists, the actual file is only ever reachable via
 * the short-lived signed URL from `GET /organisation/cac-doc/signed-url`.
 */
export class OrganisationResponseDto {
  id!: string;
  nameOfOrg!: string;
  address!: string;
  phoneNumbers!: string[];
  organisationAccountDetails!: OrganisationAccountDetail[];
  briefHistory!: string;
  businessRegNumber!: string;
  cbnLicenseNumber!: string | null;
  contactEmail!: string | null;
  cacDocUploaded!: boolean;
  createdBy!: string;
  updatedBy!: string | null;
  createdAt!: Date;
  updatedAt!: Date;

  static fromDocument(doc: OrganisationDocument): OrganisationResponseDto {
    const dto = new OrganisationResponseDto();
    dto.id = doc._id.toString();
    dto.nameOfOrg = doc.nameOfOrg;
    dto.address = doc.address;
    dto.phoneNumbers = doc.phoneNumbers;
    dto.organisationAccountDetails = doc.organisationAccountDetails;
    dto.briefHistory = doc.briefHistory;
    dto.businessRegNumber = doc.businessRegNumber;
    dto.cbnLicenseNumber = doc.cbnLicenseNumber;
    dto.contactEmail = doc.contactEmail;
    dto.cacDocUploaded = doc.cacDocKey !== null;
    dto.createdBy = doc.createdBy.toString();
    dto.updatedBy = doc.updatedBy ? doc.updatedBy.toString() : null;
    dto.createdAt = doc.createdAt;
    dto.updatedAt = doc.updatedAt;
    return dto;
  }
}
