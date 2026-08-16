import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Populates `request.user` (via JwtStrategy.validate) — the upstream guard
 * Phase 2's RBAC guards (StaffContextGuard et al.) were built expecting.
 * Always the first guard in the chain: `@UseGuards(JwtAuthGuard, StaffContextGuard, CapabilityGuard)`.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
