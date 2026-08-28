import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { AnyBulkWriteOperation, Model, Types } from 'mongoose';

import { StaffRole } from '../../common/enums/identity.enums';
import { NotificationCategory, NotificationTrigger } from '../../common/enums/notification.enums';
import { StaffService } from '../identity/staff.service';
import { Notification, NotificationDocument } from './schemas/notification.schema';

export interface PersistNotificationCopiesInput {
  type: NotificationTrigger;
  sourceEntityId: string;
  category: NotificationCategory;
  branchId: string | null;
  title: string;
  body: string;
  /** null for a customer-facing dispatch — see this method's own doc comment. */
  primaryRecipientStaffId: string | null;
}

export interface FindForStaffOptions {
  page?: number;
  limit?: number;
  unreadOnly?: boolean;
}

export interface NotificationsPage {
  items: NotificationDocument[];
  total: number;
  unreadCount: number;
  page: number;
  limit: number;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * Owns all reads/writes on the persisted in-app `Notification` collection —
 * the layer `NotificationDispatchProcessor` calls into (never throws back
 * into it, see that class's own comment) and `NotificationController`
 * exposes to each staff member as their own inbox.
 */
@Injectable()
export class NotificationInboxService {
  constructor(
    @InjectModel(Notification.name) private readonly notificationModel: Model<NotificationDocument>,
    private readonly staffService: StaffService,
  ) {}

  /**
   * Writes one row for the primary recipient plus one mirror row per active
   * SuperAdmin (skipping a SuperAdmin who *is* the primary recipient — no
   * duplicate row for them). Staff-only: a no-op (zero DB calls) when
   * `primaryRecipientStaffId` is null, i.e. every customer-facing trigger —
   * mirroring every OTP/consent-code to every SuperAdmin's inbox would make
   * the "superset of everything" property useless noise. Idempotent via the
   * schema's own unique (type, sourceEntityId, recipientStaffId) index, so a
   * BullMQ job retry safely no-ops instead of duplicating.
   */
  async persistCopies(input: PersistNotificationCopiesInput): Promise<void> {
    if (!input.primaryRecipientStaffId) {
      return;
    }

    const superAdmins = await this.staffService.findActiveByRole([StaffRole.SUPERADMIN]);
    const recipientIds = new Set<string>([input.primaryRecipientStaffId]);
    for (const superAdmin of superAdmins) {
      recipientIds.add(superAdmin._id.toString());
    }

    const operations: AnyBulkWriteOperation<Notification>[] = [...recipientIds].map((recipientStaffId) => ({
      updateOne: {
        filter: { type: input.type, sourceEntityId: input.sourceEntityId, recipientStaffId },
        update: {
          $setOnInsert: {
            recipientStaffId: new Types.ObjectId(recipientStaffId),
            type: input.type,
            category:
              recipientStaffId === input.primaryRecipientStaffId
                ? input.category
                : NotificationCategory.SUPERADMIN_MIRROR,
            sourceEntityId: input.sourceEntityId,
            branchId: input.branchId ? new Types.ObjectId(input.branchId) : null,
            title: input.title,
            body: input.body,
            isRead: false,
            readAt: null,
          },
        },
        upsert: true,
      },
    }));

    if (operations.length > 0) {
      await this.notificationModel.bulkWrite(operations);
    }
  }

  async findForStaff(staffId: string, options: FindForStaffOptions = {}): Promise<NotificationsPage> {
    const page = Math.max(1, options.page ?? 1);
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, options.limit ?? DEFAULT_PAGE_SIZE));
    const filter: Record<string, unknown> = { recipientStaffId: staffId };
    if (options.unreadOnly) {
      filter.isRead = false;
    }

    const [items, total, unreadCount] = await Promise.all([
      this.notificationModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.notificationModel.countDocuments(filter).exec(),
      this.notificationModel.countDocuments({ recipientStaffId: staffId, isRead: false }).exec(),
    ]);

    return { items, total, unreadCount, page, limit };
  }

  /** Row-scoped ownership — 404s rather than silently no-op-ing if `id` belongs to a different recipient. */
  async markRead(id: string, staffId: string): Promise<NotificationDocument> {
    const updated = await this.notificationModel
      .findOneAndUpdate(
        { _id: id, recipientStaffId: staffId },
        { $set: { isRead: true, readAt: new Date() } },
        { new: true },
      )
      .exec();
    if (!updated) {
      throw new NotFoundException(`Notification ${id} not found for this recipient`);
    }
    return updated;
  }

  async markAllRead(staffId: string): Promise<{ modifiedCount: number }> {
    const result = await this.notificationModel
      .updateMany({ recipientStaffId: staffId, isRead: false }, { $set: { isRead: true, readAt: new Date() } })
      .exec();
    return { modifiedCount: result.modifiedCount };
  }
}
