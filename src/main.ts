import 'reflect-metadata';

import { Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import express from 'express';
import helmet from 'helmet';

import { AppModule } from './app.module';
import type { AppConfig } from './common/config/configuration';
import { uploadRoot } from './common/upload/upload.config';

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

  // Uploaded staff photos/documents (see common/upload/upload.config.ts) —
  // outside the /api prefix set below, same "not itself an API route"
  // reasoning as /docs. Helmet's default same-origin Cross-Origin-Resource-
  // Policy would otherwise block the (separately-hosted) frontend from
  // loading these directly, hence the relaxed header scoped to just this path.
  app.use('/uploads', (_req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
  });
  app.use('/uploads', express.static(uploadRoot));

  app.setGlobalPrefix('api');
  // URI versioning: every route becomes /api/v1/... by default (e.g.
  // POST /api/v1/auth/login) unless a controller opts out entirely via
  // `version: VERSION_NEUTRAL` (see HealthController, kept at the stable
  // /api/health Render's own healthCheckPath expects) or opts into a
  // specific later version once one exists (`@Controller({ version: '2' })`
  // on just that controller/route — the whole app doesn't need to move to
  // v2 at once).
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

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
      .setTitle('BCKash Cooperative — Process Automation API')
      .setDescription(
        'Group business loan management platform for BCKash Cooperative. ' +
          'Authenticate via POST /api/v1/auth/login, then use the returned accessToken as a Bearer ' +
          'token below. Every route is versioned under /api/v1 except GET /api/health, which stays ' +
          'unversioned for uptime monitoring.',
      )
      .setVersion('1.0')
      .addBearerAuth(
        { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        'access-token', // referenced by @ApiBearerAuth('access-token') on protected controllers
      )
      // Purely cosmetic (Swagger UI groups/orders tags by first appearance
      // regardless of this list, but the description shows in the sidebar) —
      // one line per @ApiTags group actually used across the controllers.
      .addTag('health', 'Unauthenticated liveness probe')
      .addTag('auth', 'Login and token refresh')
      .addTag(
        'rbac',
        'SuperAdmin-only: edit the capability matrix and staff module access without a redeploy',
      )
      .addTag(
        'organisation',
        'Singleton company profile (SuperAdmin-managed) — name, address, bank accounts, CAC doc',
      )
      .addTag('reference-data', 'Static lookup data (Nigeria states/cities) — any authenticated staff')
      .addTag('departments', 'Org structure — departments')
      .addTag('units', 'Org structure — units (each belongs to a department)')
      .addTag(
        'staff',
        'Staff onboarding (workflow-mediated), direct creation, and account management',
      )
      .addTag('branches', 'Branch CRUD and manager assignment history')
      .addTag('bank-accounts', 'Branch bank account CRUD')
      .addTag('branch-funding', 'Head-office funding records for a branch')
      .addTag('customers', 'Customer KYC capture, BVN consent, and onboarding')
      .addTag('groups', 'Group formation, membership, and leadership roles')
      .addTag('loan-products', 'Loan product configuration (rates, tenure, approval chain)')
      .addTag('fee-definitions', 'Fee definitions attached to a loan product')
      .addTag('loans', 'Loan applications, disbursement verification, and fee payments')
      .addTag('repayments', 'Repayment recording, approval, and dispute handling')
      .addTag('early-liquidations', 'Paying off a loan ahead of schedule')
      .addTag(
        'accounting',
        'Chart of accounts, account mappings, the ledger, and manual journal entries',
      )
      .addTag('notifications', 'Admin-only: notification backlog drain and dead-letter visibility')
      .addTag('hr-leave-types', 'Leave type configuration (Admin-gated)')
      .addTag('hr-leave', 'Leave applications, balances, and cancellation')
      .addTag(
        'hr-salary',
        'Salary structure and change history (Admin-gated for anyone but yourself)',
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
