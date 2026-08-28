import type { AuditLogDocument } from '../../../platform/audit/schemas/audit-log.schema';

/**
 * GET /staff/:id/activity — "what has this staff member done," sourced from
 * the real append-only audit trail (AuditService.findByActor), not a
 * hand-edited log. See StaffService.getActivity.
 */
export class StaffActivityEntryDto {
  action!: string;
  entityType!: string;
  entityId!: string;
  timestamp!: Date;

  static fromDocument(doc: AuditLogDocument): StaffActivityEntryDto {
    const dto = new StaffActivityEntryDto();
    dto.action = doc.action;
    dto.entityType = doc.entityType;
    dto.entityId = doc.entityId;
    dto.timestamp = doc.timestamp;
    return dto;
  }
}
