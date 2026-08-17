import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { MongooseModule } from '@nestjs/mongoose';

import { AppConfigModule } from './common/config/app-config.module';
import type { MongoConfig, RedisConfig } from './common/config/configuration';
import { HealthController } from './common/health/health.controller';
import { AuditModule } from './platform/audit/audit.module';
import { EncryptionModule } from './platform/encryption/encryption.module';
import { RbacModule } from './platform/rbac/rbac.module';
import { WorkflowEngineModule } from './platform/workflow-engine/workflow-engine.module';
import { AccountingModule } from './modules/accounting/accounting.module';
import { BranchesModule } from './modules/branches/branches.module';
import { CustomersModule } from './modules/customers/customers.module';
import { GroupsModule } from './modules/groups/groups.module';
import { HrModule } from './modules/hr/hr.module';
import { IdentityModule } from './modules/identity/identity.module';
import { LoanProductsModule } from './modules/loan-products/loan-products.module';
import { LoansModule } from './modules/loans/loans.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { RepaymentsModule } from './modules/repayments/repayments.module';

@Module({
  imports: [
    AppConfigModule,

    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const mongo = config.get<MongoConfig>('mongo');
        return { uri: mongo?.uri };
      },
    }),

    // Root BullMQ connection. Individual queues (penalty-sweep, notification-dispatch,
    // funding-reminders, ...) are registered by the modules that own them, starting
    // in Phase 9 (repayments) and Phase 11 (notifications).
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const redis = config.get<RedisConfig>('redis');
        return {
          connection: {
            host: redis?.host,
            port: redis?.port,
            password: redis?.password,
            tls: redis?.tls ? {} : undefined,
          },
        };
      },
    }),

    // Global — WorkflowEngineService (and, later, domain modules) inject
    // EventEmitter2 directly without re-importing this module.
    //
    // *** maxListeners raised in Phase 12 — see PHASE_12_NOTES.md ***
    // Every domain module that reacts to a workflow outcome registers its
    // own `@OnEvent(WORKFLOW_APPROVED_EVENT)` listener (Customer, Loan,
    // Group, LoanProduct, FeeDefinition, Staff, ManualJournalEntry,
    // RepaymentRecord, EarlyLiquidation, and — as of this phase — both
    // LeaveApplication and SalaryRecord: 11 listeners on this one event
    // name alone). EventEmitter2's default `maxListeners` is 10 — Phase 12
    // was the one that pushed this over the default, surfaced by a genuine
    // e2e failure (`app.init()` throwing while registering the 11th
    // listener, since eventemitter2's own memory-leak-warning path itself
    // errors on newer Node). Raised generously above the current real
    // count (11), not tuned to the exact number, since this app's own
    // future maintenance will likely keep adding listeners to this same
    // handful of workflow events.
    EventEmitterModule.forRoot({ maxListeners: 30 }),

    AuditModule,
    EncryptionModule,
    RbacModule,
    WorkflowEngineModule,

    IdentityModule,
    BranchesModule,
    CustomersModule,
    GroupsModule,
    LoanProductsModule,
    AccountingModule,
    NotificationsModule,
    LoansModule,
    RepaymentsModule,
    HrModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
