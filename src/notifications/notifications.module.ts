import { Body, Controller, Delete, Get, Global, HttpCode, Module, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, type AuthUser } from '../common/auth.decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { NotificationsService } from './notifications.service.js';

const tokenSchema = z.object({ token: z.string().trim().regex(/^Expo(nent)?PushToken\[[^\]]+\]$/, 'Not an Expo push token').max(200), platform: z.enum(['ios', 'android']).default('android') });

@Controller('notifications')
class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.notifications.list(u.id);
  }

  /** This device wants push notifications for the signed-in account. */
  @HttpCode(204)
  @Post('push-token')
  async savePushToken(@CurrentUser() u: AuthUser, @Body(new ZodPipe(tokenSchema)) b: z.infer<typeof tokenSchema>) {
    await this.notifications.savePushToken(u.id, b.token, b.platform);
  }

  /** Sign-out on this device. */
  @HttpCode(204)
  @Delete('push-token')
  async removePushToken(@CurrentUser() u: AuthUser, @Body(new ZodPipe(tokenSchema.pick({ token: true }))) b: { token: string }) {
    await this.notifications.removePushToken(u.id, b.token);
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
