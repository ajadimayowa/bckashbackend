import 'reflect-metadata';

import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
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

  if (appConfig?.swaggerEnabled) {
    // Mounted at /docs, outside the /api prefix set above — a documentation
    // UI isn't itself an API route. Never exposes request/response bodies or
    // real data, only the shape of the API (routes, DTOs, auth scheme) —
    // still gated off by default in production (see SWAGGER_ENABLED / AppConfig).
    const swaggerConfig = new DocumentBuilder()
      .setTitle('BCKash Process Automation API')
      .setDescription(
        'Group business loan management platform for a cooperative society. ' +
          'Authenticate via POST /api/auth/login, then use the returned accessToken as a Bearer token below.',
      )
      .setVersion('0.0.1')
      .addBearerAuth(
        { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        'access-token', // referenced by @ApiBearerAuth('access-token') on protected controllers
      )
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, document, {
      swaggerOptions: { persistAuthorization: true },
    });
    logger.log('Swagger UI enabled at /docs');
  }

  app.enableShutdownHooks();

  const port = appConfig?.port ?? 3000;
  await app.listen(port);
  logger.log(`listening on port ${port} (env: ${appConfig?.nodeEnv ?? 'unknown'})`);
}

void bootstrap();
