import { Body, ConflictException, Controller, Get, Injectable, Param, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, Roles, type AuthUser } from '../common/auth.decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SETTING_DEFS, SETTING_KEYS, SettingsService, type SettingKey } from '../settings/settings.module.js';
import { AdminAccess } from './access.js';
import { audit, people } from './common.js';

const announcementSchema = z.object({
  title: z.string().trim().min(3, 'Add a title (at least 3 characters).').max(80),
  body: z.string().trim().min(5, 'Write the message (at least 5 characters).').max(500),
  audience: z.enum(['ALL', 'BRANDS', 'CREATORS']).default('ALL'),
});
const settingSchema = z.object({ value: z.number().int() });

@Injectable()
export class AdminPlatformService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
    private readonly access: AdminAccess,
  ) {}

  listSettings() {
    return this.settings.all();
  }

  async setSetting(adminId: string, key: string, value: number) {
    await this.access.need(adminId, 'settings');
    if (!SETTING_KEYS.includes(key as SettingKey)) throw new ConflictException('That setting does not exist.');
    const def = SETTING_DEFS[key as SettingKey];
    if (value < def.min || value > def.max) throw new ConflictException(`Choose a value between ${def.min} and ${def.max}.`);
    await this.settings.set(adminId, key as SettingKey, value);
    return this.settings.all();
  }

  async announcements() {
    const rows = await this.prisma.announcement.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
    const who = await people(this.prisma, rows.map((r) => r.createdById));
    return rows.map((r) => ({ ...r, createdBy: who.get(r.createdById) ?? null }));
  }

  /**
   * Sends an in-app announcement to everyone in the audience (it shows in their notifications and arrives live over the
   * socket). Suspended accounts are skipped. The same text can't be sent twice within ten minutes.
   */
  async announce(adminId: string, input: z.infer<typeof announcementSchema>) {
    await this.access.need(adminId, 'announcements');
    const dup = await this.prisma.announcement.findFirst({ where: { title: input.title, body: input.body, createdAt: { gt: new Date(Date.now() - 10 * 60_000) } } });
    if (dup) throw new ConflictException('This announcement was just sent.');
    const roles = input.audience === 'BRANDS' ? ['BRAND' as const] : input.audience === 'CREATORS' ? ['CREATOR' as const] : ['BRAND' as const, 'CREATOR' as const];
    const users = await this.prisma.user.findMany({ where: { role: { in: roles }, status: 'ACTIVE' }, select: { id: true } });
    const row = await this.prisma.announcement.create({ data: { title: input.title, body: input.body, audience: input.audience, createdById: adminId, sentCount: users.length } });
    // ponytail: sequential-in-chunks fan-out is fine for thousands of users; move to a queue job past ~50k.
    for (let i = 0; i < users.length; i += 25) {
      await Promise.all(users.slice(i, i + 25).map((u) => this.notifications.notify(u.id, { kind: 'announcement', title: input.title, body: input.body, linkTo: '/notifications' })));
    }
    await audit(this.prisma, adminId, 'announcement.sent', 'Announcement', row.id, { audience: input.audience, sent: users.length });
    return row;
  }
}

@Roles('ADMIN')
@Controller('admin')
export class AdminPlatformController {
  constructor(private readonly svc: AdminPlatformService) {}

  @Get('settings') settings() { return this.svc.listSettings(); }
  @Put('settings/:key') setSetting(@CurrentUser() a: AuthUser, @Param('key') key: string, @Body(new ZodPipe(settingSchema)) b: z.infer<typeof settingSchema>) { return this.svc.setSetting(a.id, key, b.value); }
  @Get('announcements') announcements() { return this.svc.announcements(); }
  @Post('announcements') announce(@CurrentUser() a: AuthUser, @Body(new ZodPipe(announcementSchema)) b: z.infer<typeof announcementSchema>) { return this.svc.announce(a.id, b); }
}
