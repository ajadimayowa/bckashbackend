import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';

import { HealthController } from '../src/common/health/health.controller';

/**
 * NOTE: this boots a minimal module (just the health endpoint + the same
 * global pipes main.ts applies) rather than the full AppModule, because
 * AppModule now wires live MongoDB + Redis connections at startup (Phase 1
 * scaffolding) and neither is available in a plain `npm run test:e2e` run.
 * Once modules land with real persistence, their e2e suites should spin up
 * mongodb-memory-server (already a devDependency) and a Redis test instance
 * as needed — full-AppModule e2e coverage will follow from there.
 */
describe('Health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health returns 200 with an ok status payload', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];
    const response = await request(httpServer).get('/health').expect(200);
    const body = response.body as { status: string; uptimeSeconds: unknown; timestamp: unknown };

    expect(body).toMatchObject({ status: 'ok' });
    expect(typeof body.uptimeSeconds).toBe('number');
    expect(typeof body.timestamp).toBe('string');
  });
});
