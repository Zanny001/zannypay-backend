import { Controller, Get, Patch, Body, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  async list(@Req() req) {
    return this.notificationsService.list(req.user.userId);
  }

  @Get('unread-count')
  async unreadCount(@Req() req) {
    return this.notificationsService.unreadCount(req.user.userId);
  }

  @Patch('read')
  async markRead(@Req() req, @Body() body: { ids?: string[]; all?: boolean }) {
    if (body.all) return this.notificationsService.markAllRead(req.user.userId);
    return this.notificationsService.markRead(req.user.userId, body.ids || []);
  }
}
