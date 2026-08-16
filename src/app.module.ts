import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';

import { AppConfigModule } from './common/config/app-config.module';
import type { MongoConfig, RedisConfig } from './common/config/configuration';
import { HealthController } from './common/health/health.controller';

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
    // in Phase 2 (platform/jobs) and Phase 11 (notifications).
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
  ],
  controllers: [HealthController],
})
export class AppModule {}
