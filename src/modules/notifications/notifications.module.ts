import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { BranchesModule } from '../branches/branches.module';
import { CustomersModule } from '../customers/customers.module';
import { IdentityModule } from '../identity/identity.module';
import { NOTIFICATION_PORT } from '../loans/interfaces/notification-port.interface';
// Cross-module raw schema registration only — see RealNotificationPort's own comment.
import { Loan, LoanSchema } from '../loans/schemas/loan.schema';
import { BrevoModule } from '../../platform/integrations/brevo/brevo.module';
import { TermiiModule } from '../../platform/integrations/termii/termii.module';
import { WorkflowEngineModule } from '../../platform/workflow-engine/workflow-engine.module';
import { NotificationAdminController } from './notification-admin.controller';
import { NotificationBacklogDrainService } from './notification-backlog-drain.service';
import { NotificationDeadLetterLogService } from './notification-dead-letter-log.service';
import { NotificationDispatchProcessor } from './notification-dispatch.processor';
import { NOTIFICATION_DISPATCH_QUEUE } from './notification-dispatch.queue';
import { NotificationService } from './notification.service';
import { CustomerRecipientResolver } from './recipient-resolution/customer-recipient.resolver';
import { InvolvedPartiesResolver } from './recipient-resolution/involved-parties.resolver';
import { RealNotificationPort } from './real-notification.port';
import {
  NotificationDeadLetterLog,
  NotificationDeadLetterLogSchema,
} from './schemas/notification-dead-letter-log.schema';
import {
  PendingNotificationLog,
  PendingNotificationLogSchema,
} from './schemas/pending-notification-log.schema';
import { NotificationTemplateRegistry } from './templates/notification-template-registry.service';

/**
 * Owns the real email/SMS dispatch pipeline and the real `NotificationPort`
 * — `NOTIFICATION_PORT` is bound here (to `RealNotificationPort`) and
 * exported so `LoansModule`/`RepaymentsModule` can rebind their own token
 * via `useExisting`, same pattern as `AccountingModule`/`LedgerPostingService`
 * in Phase 10. No dependency on `modules/loans` beyond the one raw `Loan`
 * schema registration (read-only, for `sendVerificationEscalation`'s
 * involved-parties resolution) — no circular import.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PendingNotificationLog.name, schema: PendingNotificationLogSchema },
      { name: NotificationDeadLetterLog.name, schema: NotificationDeadLetterLogSchema },
      { name: Loan.name, schema: LoanSchema },
    ]),
    BullModule.registerQueue({ name: NOTIFICATION_DISPATCH_QUEUE }),
    BrevoModule,
    TermiiModule,
    WorkflowEngineModule,
    IdentityModule,
    BranchesModule,
    CustomersModule,
  ],
  controllers: [NotificationAdminController],
  providers: [
    NotificationTemplateRegistry,
    NotificationService,
    NotificationDispatchProcessor,
    NotificationBacklogDrainService,
    NotificationDeadLetterLogService,
    CustomerRecipientResolver,
    InvolvedPartiesResolver,
    RealNotificationPort,
    { provide: NOTIFICATION_PORT, useExisting: RealNotificationPort },
  ],
  // RealNotificationPort itself exported (not just the NOTIFICATION_PORT
  // token) so LoansModule can rebind its own token via `useExisting` — same
  // pattern as AccountingModule/LedgerPostingService in Phase 10.
  exports: [NOTIFICATION_PORT, NotificationService, RealNotificationPort],
})
export class NotificationsModule {}
