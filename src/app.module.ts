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
import { BranchesModule } from './modules/branches/branches.module';
import { CustomersModule } from './modules/customers/customers.module';
import { GroupsModule } from './modules/groups/groups.module';
import { IdentityModule } from './modules/identity/identity.module';
import { LoanProductsModule } from './modules/loan-products/loan-products.module';
import { LoansModule } from './modules/loans/loans.module';
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
    EventEmitterModule.forRoot(),

    AuditModule,
    EncryptionModule,
    RbacModule,
    WorkflowEngineModule,

    IdentityModule,
    BranchesModule,
    CustomersModule,
    GroupsModule,
    LoanProductsModule,
    LoansModule,
    RepaymentsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
