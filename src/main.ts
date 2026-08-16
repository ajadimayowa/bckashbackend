import 'reflect-metadata';

import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';

import { AppModule } from './app.module';
import type { AppConfig } from './common/config/configuration';

const logger = new Logger('Bootstrap');

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    // Render terminates TLS at the edge; trust its proxy for correct
    // req.ip / req.protocol when we later rely on them (rate limiting, audit log).
    cors: true,
  });

  const configService = app.get(ConfigService);
  const appConfig = configService.get<AppConfig>('app');

  app.use(helmet());
  app.setGlobalPrefix('api');

  // Financial API: never trust client input. class-validator DTOs are the
  // single point of enforcement — whitelist strips unknown fields,
  // forbidNonWhitelisted rejects requests that send them, transform lets
  // controllers receive typed instances instead of plain objects.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.enableShutdownHooks();

  const port = appConfig?.port ?? 3000;
  await app.listen(port);
  logger.log(`listening on port ${port} (env: ${appConfig?.nodeEnv ?? 'unknown'})`);
}

void bootstrap();
