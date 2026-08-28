import { AuditLogDocument } from '../../../platform/audit/schemas/audit-log.schema';

/** One entry of a customer's audit trail — see CustomerService.getAuditTrail. */
export class CustomerAuditEntryDto {
  id!: string;
  actorId!: string | null;
  /** Resolved via CustomerService.resolveStaffNames — null for a system action, or a staff record that no longer exists. */
  actorName!: string | null;
  action!: string;
  before!: Record<string, unknown> | null;
  after!: Record<string, unknown> | null;
  metadata!: Record<string, unknown> | null;
  timestamp!: Date;

  static fromDocument(doc: AuditLogDocument, actorName: string | null = null): CustomerAuditEntryDto {
    const dto = new CustomerAuditEntryDto();
    dto.id = doc._id.toString();
    dto.actorId = doc.actorId;
    dto.actorName = actorName;
    dto.action = doc.action;
    dto.before = doc.before ?? null;
    dto.after = doc.after ?? null;
    dto.metadata = doc.metadata ?? null;
    dto.timestamp = doc.timestamp;
    return dto;
  }
}
