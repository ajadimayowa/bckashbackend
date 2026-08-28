import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

interface HealthResponse {
  status: 'ok';
  uptimeSeconds: number;
  timestamp: string;
}

/**
 * Unauthenticated liveness probe for Render's health checks.
 * Deliberately reveals nothing about downstream dependencies (Mongo/Redis) —
 * a readiness probe covering those can be added once the platform layer
 * (Phase 2) has somewhere to report component health.
 *
 * `version: VERSION_NEUTRAL` — stays reachable at exactly `/api/health`
 * (no `/v1` segment), matching `render.yaml`'s own `healthCheckPath` and
 * never moving out from under it as the API's versioned routes evolve —
 * an infra health probe shouldn't need to change every time the API does.
 */
@ApiTags('health')
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  @Get()
  @ApiOperation({
    summary: 'Liveness probe',
    description:
      'Unauthenticated health check for Render (and any other uptime monitor). Always at /api/health, unversioned.',
  })
  check(): HealthResponse {
    return {
      status: 'ok',
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }
}
