import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import {
  NotificationDeadLetterLog,
  NotificationDeadLetterLogDocument,
} from './schemas/notification-dead-letter-log.schema';

const DEFAULT_PAGE_SIZE = 20;

/** Simple, paginated read surface over NotificationDeadLetterLog — "so Admins can see what didn't go out." */
@Injectable()
export class NotificationDeadLetterLogService {
  constructor(
    @InjectModel(NotificationDeadLetterLog.name)
    private readonly deadLetterModel: Model<NotificationDeadLetterLogDocument>,
  ) {}

  async findAll(
    options: { page?: number; pageSize?: number } = {},
  ): Promise<{ items: NotificationDeadLetterLog[]; total: number }> {
    const page = options.page && options.page > 0 ? options.page : 1;
    const pageSize =
      options.pageSize && options.pageSize > 0 ? options.pageSize : DEFAULT_PAGE_SIZE;

    const [items, total] = await Promise.all([
      this.deadLetterModel
        .find({})
        .sort({ failedAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .exec(),
      this.deadLetterModel.countDocuments({}).exec(),
    ]);
    return { items, total };
  }
}
