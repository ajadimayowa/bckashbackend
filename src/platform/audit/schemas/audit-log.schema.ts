import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type AuditLogDocument = HydratedDocument<AuditLog>;

/**
 * Append-only record of every state-changing action across the system — not just
 * workflow transitions. Written to directly by the workflow engine on every
 * transition, and callable by any domain module for non-workflow-mediated
 * sensitive actions (e.g. logging a KYC data read once the customers module exists).
 *
 * No update/delete path exists anywhere in this module — see AuditService.
 */
@Schema({ timestamps: false, collection: 'audit_logs' })
export class AuditLog {
  /** null for system/scheduled-job actions (e.g. the penalty sweep) rather than a staff member. */
  @Prop({ type: String, default: null })
  actorId!: string | null;

  /**
   * Free-text but consistent, e.g. "WORKFLOW_REQUEST_APPROVED", "KYC_DATA_READ",
   * "STAFF_DISABLED". Not a closed enum — the set of auditable actions grows with
   * every module and shouldn't require touching this schema each time.
   */
  @Prop({ type: String, required: true })
  action!: string;

  @Prop({ type: String, required: true })
  entityType!: string;

  @Prop({ type: String, required: true })
  entityId!: string;

  @Prop({ type: Object, default: null })
  before?: Record<string, unknown> | null;

  @Prop({ type: Object, default: null })
  after?: Record<string, unknown> | null;

  /** e.g. branchId, ip address, request id — whatever context is available at the call site. */
  @Prop({ type: Object, default: null })
  metadata?: Record<string, unknown> | null;

  @Prop({ type: Date, required: true, default: () => new Date() })
  timestamp!: Date;
}

export const AuditLogSchema = SchemaFactory.createForClass(AuditLog);

AuditLogSchema.index({ entityType: 1, entityId: 1, timestamp: -1 });
AuditLogSchema.index({ actorId: 1, timestamp: -1 });
AuditLogSchema.index({ action: 1, timestamp: -1 });
