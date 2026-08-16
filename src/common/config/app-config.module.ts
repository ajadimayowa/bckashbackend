import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import configuration from './configuration';
import { envValidationSchema } from './env.validation';

/**
 * Wraps @nestjs/config with our validation schema + typed config factory.
 * Imported once, globally, from AppModule — every other module reads
 * config via ConfigService, never via `process.env` directly.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env'],
      load: [configuration],
      validationSchema: envValidationSchema,
      validationOptions: {
        abortEarly: false,
      },
    }),
  ],
})
export class AppConfigModule {}
