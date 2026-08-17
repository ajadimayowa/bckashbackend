import { Injectable, InternalServerErrorException, Logger, OnModuleInit } from '@nestjs/common';

import { NotificationTrigger } from '../../../common/enums/notification.enums';
import { NOTIFICATION_TEMPLATES } from './notification-templates';
import { NotificationTemplate } from './notification-template.interface';

/**
 * Thin wrapper around the static `NOTIFICATION_TEMPLATES` map — "registered"
 * happens at import time (the map is a plain const), but `onModuleInit`
 * defensively asserts every `NotificationTrigger` value actually has an
 * entry, so a future enum addition without a matching template fails loudly
 * at boot rather than silently producing an empty notification body later.
 */
@Injectable()
export class NotificationTemplateRegistry implements OnModuleInit {
  private readonly logger = new Logger(NotificationTemplateRegistry.name);

  onModuleInit(): void {
    const missing = Object.values(NotificationTrigger).filter(
      (type) => !NOTIFICATION_TEMPLATES[type],
    );
    if (missing.length > 0) {
      throw new InternalServerErrorException(
        `NotificationTemplateRegistry: missing template(s) for ${missing.join(', ')}`,
      );
    }
    this.logger.log(
      `Registered ${Object.keys(NOTIFICATION_TEMPLATES).length} notification templates.`,
    );
  }

  getTemplate(type: NotificationTrigger): NotificationTemplate {
    const template = NOTIFICATION_TEMPLATES[type];
    if (!template) {
      throw new InternalServerErrorException(`No notification template registered for ${type}`);
    }
    return template;
  }
}
