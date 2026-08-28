import { Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentStaffContext } from '../../platform/rbac/decorators/current-staff-context.decorator';
import { CapabilityGuard } from '../../platform/rbac/guards/capability.guard';
import { StaffContextGuard } from '../../platform/rbac/guards/staff-context.guard';
import type { ResolvedStaffContext } from '../../platform/rbac/interfaces/staff-context.interface';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { NotificationInboxService, NotificationsPage } from './notification-inbox.service';
import { Notification } from './schemas/notification.schema';

/**
 * Staff-facing "my own inbox" surface — deliberately a separate controller
 * from `NotificationAdminController` (that one is class-level gated by
 * `NOTIFICATIONS_MANAGE_CAPABILITY`; every route here is authenticated-only
 * and row-scoped to the caller's own `staffId` instead, same "it's your own
 * inbox" posture as `GET /branch-funding`). SuperAdmin sees everything by
 * construction — every notification mirrors to every SuperAdmin's own rows
 * (see NotificationInboxService.persistCopies) — no separate admin-only
 * listing endpoint is needed for that.
 */
@ApiTags('notifications')
@ApiBearerAuth('access-token')
@Controller('notifications')
@UseGuards(JwtAuthGuard, StaffContextGuard, CapabilityGuard)
export class NotificationController {
  constructor(private readonly inboxService: NotificationInboxService) {}

  @Get('me')
  @ApiOperation({ summary: 'My own paginated notification inbox', description: 'Optionally ?unreadOnly=true.' })
  findMine(
    @Query('page') page: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('unreadOnly') unreadOnly: string | undefined,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<NotificationsPage> {
    return this.inboxService.findForStaff(actor.staffId, {
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      unreadOnly: unreadOnly === 'true',
    });
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Mark one of my own notifications read' })
  markRead(
    @Param('id') id: string,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<Notification> {
    return this.inboxService.markRead(id, actor.staffId);
  }

  @Post('mark-all-read')
  @ApiOperation({ summary: 'Mark every one of my own unread notifications read' })
  markAllRead(@CurrentStaffContext() actor: ResolvedStaffContext): Promise<{ modifiedCount: number }> {
    return this.inboxService.markAllRead(actor.staffId);
  }
}
