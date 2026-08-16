import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

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
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
  @Get()
  check(): HealthResponse {
    return {
      status: 'ok',
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }
}
