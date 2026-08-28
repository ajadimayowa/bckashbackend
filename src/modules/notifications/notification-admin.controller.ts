import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { NOTIFICATIONS_MANAGE_CAPABILITY } from '../../platform/rbac/constants/capabilities';
import { RequireCapability } from '../../platform/rbac/decorators/require-capability.decorator';
import { CapabilityGuard } from '../../platform/rbac/guards/capability.guard';
import { StaffContextGuard } from '../../platform/rbac/guards/staff-context.guard';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import {
  BacklogDrainResult,
  NotificationBacklogDrainService,
} from './notification-backlog-drain.service';
import { NotificationDeadLetterLog } from './schemas/notification-dead-letter-log.schema';
import { NotificationDeadLetterLogService } from './notification-dead-letter-log.service';

/**
 * Admin-only notification ops surface — no `ModuleName` exists for
 * notifications (unlike accounting/loans), so gated purely by the flat
 * `NOTIFICATIONS_MANAGE_CAPABILITY` (ADMIN/SUPERADMIN by default).
 */
@ApiTags('notifications')
@ApiBearerAuth('access-token')
@Controller('notifications')
@UseGuards(JwtAuthGuard, StaffContextGuard, CapabilityGuard)
@RequireCapability(NOTIFICATIONS_MANAGE_CAPABILITY)
export class NotificationAdminController {
  constructor(
    private readonly backlogDrainService: NotificationBacklogDrainService,
    private readonly deadLetterLogService: NotificationDeadLetterLogService,
  ) {}

  /**
   * Explicit, Admin-triggered — deliberately not run automatically on every
   * deploy/boot. See NotificationBacklogDrainService's own doc comment for
   * why this is safe to call more than once.
   */
  @Post('backlog/drain')
  @ApiOperation({
    summary: 'Drain the PendingNotificationLog backlog',
    description: 'Idempotent — safe to call more than once, including a restart mid-drain.',
  })
  drainBacklog(): Promise<BacklogDrainResult> {
    return this.backlogDrainService.drain();
  }

  @Get('dead-letters')
  @ApiOperation({
    summary: 'List notifications that exhausted every retry attempt',
    description: 'Paginated.',
  })
  findDeadLetters(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<{ items: NotificationDeadLetterLog[]; total: number }> {
    return this.deadLetterLogService.findAll({
      page: page ? parseInt(page, 10) : undefined,
      pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
    });
  }
}
