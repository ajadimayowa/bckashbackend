import { AuditLogDocument } from '../../../platform/audit/schemas/audit-log.schema';

/** One entry of a branch's activity trail — see BranchesService.getActivity. Doubles as the Manager dashboard's "notifications from head office" feed. */
export class BranchActivityEntryDto {
  id!: string;
  actorId!: string | null;
  /** Resolved via BranchesService.resolveStaffNames — null for a system action, or a staff record that no longer exists. */
  actorName!: string | null;
  action!: string;
  before!: Record<string, unknown> | null;
  after!: Record<string, unknown> | null;
  metadata!: Record<string, unknown> | null;
  timestamp!: Date;

  static fromDocument(doc: AuditLogDocument, actorName: string | null = null): BranchActivityEntryDto {
    const dto = new BranchActivityEntryDto();
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
