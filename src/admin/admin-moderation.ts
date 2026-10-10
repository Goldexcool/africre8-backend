import { Body, ConflictException, Controller, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, Roles, type AuthUser } from '../common/auth.decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import type { Prisma } from '../generated/prisma/client.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AdminAccess } from './access.js';
import { audit, pageQuery, people } from './common.js';

export const REPORT_REASONS = ['spam', 'harassment', 'scam', 'inappropriate', 'fake', 'other'] as const;
export const REPORT_TARGETS = ['USER', 'OPPORTUNITY', 'MESSAGE'] as const;

const briefsQuery = z.object({ status: z.enum(['DRAFT', 'PUBLISHED', 'CLOSED', 'ALL']).default('PUBLISHED'), q: z.string().trim().max(100).optional(), ...pageQuery });
const reasonSchema = z.object({ reason: z.string().trim().min(3, 'Give a reason (at least 3 characters).').max(500) });
const profileSchema = z.object({ action: z.enum(['remove_avatar', 'remove_portfolio', 'remove_bio', 'remove_logo']), reason: reasonSchema.shape.reason });
const reportsQuery = z.object({ status: z.enum(['OPEN', 'ACTIONED', 'DISMISSED', 'ALL']).default('OPEN'), targetType: z.enum(REPORT_TARGETS).optional(), ...pageQuery });
const resolveSchema = z.object({ action: z.enum(['dismiss', 'warn', 'remove_content', 'suspend']), note: z.string().trim().min(3, 'Write a short note (at least 3 characters).').max(500) });
export const reportSchema = z.object({
  targetType: z.enum(REPORT_TARGETS),
  targetId: z.string().uuid(),
  reason: z.enum(REPORT_REASONS),
  details: z.string().trim().max(1000).optional(),
});

@Injectable()
export class AdminModerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly access: AdminAccess,
  ) {}

  // ---------- Briefs ----------

  async briefs(q: z.infer<typeof briefsQuery>) {
    const where: Prisma.OpportunityWhereInput = {
      ...(q.status === 'ALL' ? {} : { status: q.status }),
      ...(q.q ? { title: { contains: q.q, mode: 'insensitive' } } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.opportunity.count({ where }),
      this.prisma.opportunity.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { _count: { select: { interests: true } } } }),
    ]);
    const who = await people(this.prisma, rows.map((r) => r.brandId));
    return { items: rows.map(({ _count, ...o }) => ({ ...o, interests: _count.interests, brand: who.get(o.brandId) ?? null })), total, page: q.page, pageSize: q.pageSize };
  }

  /** Takes a brief down. The brand is told why and can't republish it. Closing an already closed brief is a no-op. */
  async removeBrief(adminId: string, id: string, reason: string) {
    await this.access.need(adminId, 'moderation');
    const o = await this.prisma.opportunity.findUnique({ where: { id } });
    if (!o) throw new NotFoundException('Brief not found');
    if (o.removedAt) throw new ConflictException('This brief was already removed.');
    await this.prisma.opportunity.update({ where: { id }, data: { status: 'CLOSED', removedAt: new Date(), removedReason: reason } });
    await audit(this.prisma, adminId, 'moderation.brief_removed', 'Opportunity', id, { reason });
    await this.notifications.notify(o.brandId, { kind: 'account', title: 'A brief was removed', body: `AfiCre8 removed “${o.title}”: ${reason}`, linkTo: '/(tabs)/(brand)/campaigns' });
    return this.prisma.opportunity.findUnique({ where: { id } });
  }

  async closeBrief(adminId: string, id: string, reason: string) {
    await this.access.need(adminId, 'moderation');
    const o = await this.prisma.opportunity.findUnique({ where: { id } });
    if (!o) throw new NotFoundException('Brief not found');
    if (o.status === 'CLOSED') throw new ConflictException('This brief is already closed.');
    await this.prisma.opportunity.update({ where: { id }, data: { status: 'CLOSED' } });
    await audit(this.prisma, adminId, 'moderation.brief_closed', 'Opportunity', id, { reason });
    await this.notifications.notify(o.brandId, { kind: 'account', title: 'A brief was closed', body: `AfiCre8 closed “${o.title}”: ${reason}`, linkTo: '/(tabs)/(brand)/campaigns' });
    return this.prisma.opportunity.findUnique({ where: { id } });
  }

  // ---------- Profile content ----------

  /** Removes one piece of a profile (photo, portfolio, bio, logo). The person is told; the account stays active. */
  async moderateProfile(adminId: string, userId: string, input: z.infer<typeof profileSchema>) {
    await this.access.need(adminId, 'moderation');
    const u = await this.prisma.user.findUnique({ where: { id: userId }, include: { creatorProfile: true, brandProfile: true } });
    if (!u) throw new NotFoundException('User not found');
    const labels = { remove_avatar: 'profile photo', remove_portfolio: 'portfolio', remove_bio: 'bio', remove_logo: 'logo' } as const;
    if (u.creatorProfile && input.action === 'remove_avatar') await this.prisma.creatorProfile.update({ where: { userId }, data: { avatarUrl: null } });
    else if (u.creatorProfile && input.action === 'remove_portfolio') await this.prisma.creatorProfile.update({ where: { userId }, data: { portfolio: [] } });
    else if (u.creatorProfile && input.action === 'remove_bio') await this.prisma.creatorProfile.update({ where: { userId }, data: { bio: null } });
    else if (u.brandProfile && input.action === 'remove_logo') await this.prisma.brandProfile.update({ where: { userId }, data: { logoUrl: null } });
    else if (u.brandProfile && input.action === 'remove_bio') await this.prisma.brandProfile.update({ where: { userId }, data: { about: null } });
    else throw new ConflictException(`This account has no ${labels[input.action]} to remove.`);
    await audit(this.prisma, adminId, 'moderation.profile_content_removed', 'User', userId, { action: input.action, reason: input.reason });
    await this.notifications.notify(userId, { kind: 'account', title: 'Profile content removed', body: `AfiCre8 removed your ${labels[input.action]}: ${input.reason}`, linkTo: '/profile' });
    return { ok: true };
  }

  // ---------- Reports ----------

  async reports(q: z.infer<typeof reportsQuery>) {
    const where: Prisma.ReportWhereInput = { ...(q.status === 'ALL' ? {} : { status: q.status }), ...(q.targetType ? { targetType: q.targetType } : {}) };
    const [total, rows] = await Promise.all([
      this.prisma.report.count({ where }),
      this.prisma.report.findMany({ where, orderBy: { createdAt: q.status === 'OPEN' ? 'asc' : 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    const who = await people(this.prisma, rows.flatMap((r) => [r.reporterId, r.handledById]));
    return { items: rows.map((r) => ({ ...r, reporter: who.get(r.reporterId) ?? null, handledBy: r.handledById ? (who.get(r.handledById) ?? null) : null })), total, page: q.page, pageSize: q.pageSize };
  }

  async report(id: string) {
    const r = await this.prisma.report.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Report not found');
    const target = await this.targetOf(r.targetType, r.targetId);
    const [others, who] = await Promise.all([
      this.prisma.report.count({ where: { targetType: r.targetType, targetId: r.targetId, id: { not: id } } }),
      people(this.prisma, [r.reporterId, r.handledById, target?.ownerId]),
    ]);
    return { report: { ...r, reporter: who.get(r.reporterId) ?? null, handledBy: r.handledById ? (who.get(r.handledById) ?? null) : null }, target: target ? { ...target.view, owner: target.ownerId ? (who.get(target.ownerId) ?? null) : null } : null, otherReportsOnTarget: others };
  }

  /** What was reported, who owns it, and what it says. Null when it no longer exists. */
  private async targetOf(type: string, id: string): Promise<{ ownerId: string | null; view: Record<string, unknown> } | null> {
    if (type === 'USER') {
      const u = await this.prisma.user.findUnique({ where: { id }, select: { id: true, role: true, status: true, email: true, creatorProfile: { select: { displayName: true, bio: true, avatarUrl: true } }, brandProfile: { select: { businessName: true, about: true, logoUrl: true } } } });
      return u ? { ownerId: u.id, view: { type, id, role: u.role, status: u.status, name: u.creatorProfile?.displayName ?? u.brandProfile?.businessName ?? u.email, bio: u.creatorProfile?.bio ?? u.brandProfile?.about ?? null, imageUrl: u.creatorProfile?.avatarUrl ?? u.brandProfile?.logoUrl ?? null } } : null;
    }
    if (type === 'OPPORTUNITY') {
      const o = await this.prisma.opportunity.findUnique({ where: { id } });
      return o ? { ownerId: o.brandId, view: { type, id, title: o.title, brief: o.brief, status: o.status, removedAt: o.removedAt } } : null;
    }
    const m = await this.prisma.message.findUnique({ where: { id }, select: { id: true, text: true, senderId: true, createdAt: true } });
    return m ? { ownerId: m.senderId, view: { type, id, text: m.text, createdAt: m.createdAt } } : null;
  }

  /** Closes a report. The reporter is told it was reviewed; the person reported is told only if something was done. */
  async resolve(adminId: string, id: string, input: z.infer<typeof resolveSchema>) {
    await this.access.need(adminId, 'moderation');
    const r = await this.prisma.report.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Report not found');
    const target = await this.targetOf(r.targetType, r.targetId);
    const owner = target?.ownerId ?? null;
    if (input.action !== 'dismiss' && !target) throw new ConflictException('What was reported no longer exists. Dismiss the report.');
    const claimed = await this.prisma.report.updateMany({ where: { id, status: 'OPEN' }, data: { status: input.action === 'dismiss' ? 'DISMISSED' : 'ACTIONED', action: input.action, handledNote: input.note, handledById: adminId, handledAt: new Date() } });
    if (claimed.count !== 1) throw new ConflictException('This report was already handled.');

    if (input.action === 'warn' && owner) await this.notifications.notify(owner, { kind: 'account', title: 'A warning from AfiCre8', body: `Your ${r.targetType === 'MESSAGE' ? 'message' : r.targetType === 'OPPORTUNITY' ? 'brief' : 'profile'} was reported. ${input.note}`, linkTo: '/profile' });
    if (input.action === 'remove_content' && target) await this.removeContent(adminId, r.targetType, r.targetId, owner, input.note);
    if (input.action === 'suspend' && owner) {
      const owned = await this.prisma.user.findUnique({ where: { id: owner }, select: { role: true, status: true } });
      if (owned && owned.role !== 'ADMIN' && owned.status === 'ACTIVE') {
        await this.prisma.$transaction([
          this.prisma.user.update({ where: { id: owner }, data: { status: 'SUSPENDED', suspendedReason: input.note } }),
          this.prisma.refreshToken.updateMany({ where: { userId: owner, revokedAt: null }, data: { revokedAt: new Date() } }),
        ]);
      }
    }
    await audit(this.prisma, adminId, 'moderation.report_handled', 'Report', id, { action: input.action, targetType: r.targetType, targetId: r.targetId });
    await this.notifications.notify(r.reporterId, { kind: 'account', title: 'We reviewed your report', body: input.action === 'dismiss' ? 'Thanks for telling us. We did not find a problem that needs action.' : 'Thanks for telling us. We took action.', linkTo: '/notifications' });
    return this.report(id);
  }

  private async removeContent(adminId: string, type: string, id: string, owner: string | null, note: string) {
    if (type === 'OPPORTUNITY') await this.prisma.opportunity.update({ where: { id }, data: { status: 'CLOSED', removedAt: new Date(), removedReason: note } });
    else if (type === 'MESSAGE') await this.prisma.message.update({ where: { id }, data: { text: '[This message was removed by AfiCre8]' } });
    else if (type === 'USER') {
      await this.prisma.creatorProfile.updateMany({ where: { userId: id }, data: { avatarUrl: null, portfolio: [], bio: null } });
      await this.prisma.brandProfile.updateMany({ where: { userId: id }, data: { logoUrl: null, about: null } });
    }
    if (owner) await this.notifications.notify(owner, { kind: 'account', title: 'Content removed', body: `AfiCre8 removed content that was reported. ${note}`, linkTo: '/profile' });
  }
}

@Roles('ADMIN')
@Controller('admin')
export class AdminModerationController {
  constructor(private readonly svc: AdminModerationService) {}

  @Get('briefs') briefs(@Query(new ZodPipe(briefsQuery)) q: z.infer<typeof briefsQuery>) { return this.svc.briefs(q); }
  @Post('briefs/:id/remove') removeBrief(@CurrentUser() a: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(reasonSchema)) b: z.infer<typeof reasonSchema>) { return this.svc.removeBrief(a.id, id, b.reason); }
  @Post('briefs/:id/close') closeBrief(@CurrentUser() a: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(reasonSchema)) b: z.infer<typeof reasonSchema>) { return this.svc.closeBrief(a.id, id, b.reason); }
  @Post('users/:id/moderate') moderate(@CurrentUser() a: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(profileSchema)) b: z.infer<typeof profileSchema>) { return this.svc.moderateProfile(a.id, id, b); }
  @Get('reports') reports(@Query(new ZodPipe(reportsQuery)) q: z.infer<typeof reportsQuery>) { return this.svc.reports(q); }
  @Get('reports/:id') report(@Param('id', ParseUUIDPipe) id: string) { return this.svc.report(id); }
  @Post('reports/:id/resolve') resolve(@CurrentUser() a: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(resolveSchema)) b: z.infer<typeof resolveSchema>) { return this.svc.resolve(a.id, id, b); }
}

/** Any signed-in brand or creator can report a profile, a brief or a message they can see. */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async create(userId: string, input: z.infer<typeof reportSchema>) {
    const { targetType, targetId } = input;
    if (targetType === 'USER') {
      if (targetId === userId) throw new ConflictException("You can't report yourself.");
      if (!(await this.prisma.user.findUnique({ where: { id: targetId }, select: { id: true } }))) throw new NotFoundException('That profile was not found.');
    } else if (targetType === 'OPPORTUNITY') {
      const o = await this.prisma.opportunity.findUnique({ where: { id: targetId }, select: { brandId: true } });
      if (!o) throw new NotFoundException('That brief was not found.');
      if (o.brandId === userId) throw new ConflictException("You can't report your own brief.");
    } else {
      const m = await this.prisma.message.findUnique({ where: { id: targetId }, include: { conversation: { include: { match: { select: { brandId: true, creatorId: true } } } } } });
      const match = m?.conversation.match;
      if (!m || !match || (match.brandId !== userId && match.creatorId !== userId)) throw new NotFoundException('That message was not found.');
      if (m.senderId === userId) throw new ConflictException("You can't report your own message.");
    }
    const dup = await this.prisma.report.findFirst({ where: { reporterId: userId, targetType, targetId, status: 'OPEN' } });
    if (dup) throw new ConflictException('You already reported this. We are reviewing it.');
    const row = await this.prisma.report.create({ data: { reporterId: userId, targetType, targetId, reason: input.reason, details: input.details } });
    const admins = await this.prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } });
    for (const a of admins) await this.notifications.notify(a.id, { kind: 'account', title: 'New report', body: `${targetType.toLowerCase()} reported: ${input.reason}`, linkTo: '/admin/reports' });
    return { id: row.id, status: row.status };
  }
}

@Roles('BRAND', 'CREATOR')
@Controller('reports')
export class ReportsController {
  constructor(private readonly svc: ReportsService) {}

  @Post() create(@CurrentUser() u: AuthUser, @Body(new ZodPipe(reportSchema)) b: z.infer<typeof reportSchema>) { return this.svc.create(u.id, b); }
}
