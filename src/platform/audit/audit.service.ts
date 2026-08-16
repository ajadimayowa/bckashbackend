import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { AuditLog, AuditLogDocument } from './schemas/audit-log.schema';

export interface RecordAuditEntryInput {
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  /** Defaults to now — only override for backfilling/tests. */
  timestamp?: Date;
}

/**
 * Append-only audit trail. `record()` is the only write path this service exposes
 * — there is deliberately no `update`/`delete`/`remove` method here, at the
 * TypeScript level, not just by convention. The injected Mongoose model is
 * `private`, so nothing outside this class can reach past it either.
 */
@Injectable()
export class AuditService {
  constructor(
    @InjectModel(AuditLog.name) private readonly auditLogModel: Model<AuditLogDocument>,
  ) {}

  async record(entry: RecordAuditEntryInput): Promise<AuditLogDocument> {
    return this.auditLogModel.create({
      actorId: entry.actorId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      before: entry.before ?? null,
      after: entry.after ?? null,
      metadata: entry.metadata ?? null,
      timestamp: entry.timestamp ?? new Date(),
    });
  }

  /** Full timeline for a single entity, oldest first. */
  async findByEntity(entityType: string, entityId: string): Promise<AuditLogDocument[]> {
    return this.auditLogModel.find({ entityType, entityId }).sort({ timestamp: 1 }).exec();
  }

  /** "What did this staff member do" — newest first. */
  async findByActor(actorId: string): Promise<AuditLogDocument[]> {
    return this.auditLogModel.find({ actorId }).sort({ timestamp: -1 }).exec();
  }
}
