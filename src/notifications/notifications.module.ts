import { Controller, Get, Global, HttpCode, Module, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../common/auth.decorators.js';
import { NotificationsService } from './notifications.service.js';

@Controller('notifications')
class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.notifications.list(u.id);
  }

  @HttpCode(204)
  @Post(':id/read')
  async read(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.notifications.markRead(u.id, id);
  }
}

@Global()
@Module({ controllers: [NotificationsController], providers: [NotificationsService], exports: [NotificationsService] })
export class NotificationsModule {}
