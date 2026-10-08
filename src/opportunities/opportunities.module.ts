import { Body, ConflictException, Controller, Get, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, Roles, type AuthUser } from '../common/auth.decorators.js';
import { OnboardedGuard } from '../common/onboarded.guard.js';
import { ZodPipe } from '../common/zod.pipe.js';
import type { Opportunity } from '../generated/prisma/client.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

const briefSchema = z.object({
  title: z.string().trim().min(3).max(120),
  brief: z.string().trim().min(10).max(4000),
  category: z.string().trim().min(2),
  budgetNgn: z.number().int().min(1000).max(50_000_000),
  deadlineDays: z.number().int().min(1).max(365),
  deliverables: z.array(z.string().trim().min(2)).min(1).max(10),
  coverImageUrl: z.string().url().optional(),
  visibility: z.enum(['PUBLIC', 'PRIVATE']).default('PUBLIC'),
  /** Stop accepting applications after this many (null = no cap). */
  applicationLimit: z.number().int().min(1).max(500).nullable().optional(),
  status: z.enum(['DRAFT', 'PUBLISHED']).default('PUBLISHED'),
});
type BriefInput = z.infer<typeof briefSchema>;
const applySchema = z.object({ message: z.string().trim().min(10).max(1000) });
const INTEREST_TTL_DAYS = 14;

@Injectable()
export class OpportunitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async create(brandId: string, b: BriefInput) {
    const { budgetNgn, ...rest } = b;
    return this.view(await this.prisma.opportunity.create({ data: { ...rest, brandId, budgetKobo: budgetNgn * 100, applicationLimit: b.applicationLimit ?? null } }));
  }

  async update(brandId: string, id: string, b: BriefInput) {
    await this.owned(brandId, id);
    const { budgetNgn, ...rest } = b;
    return this.view(await this.prisma.opportunity.update({ where: { id }, data: { ...rest, budgetKobo: budgetNgn * 100, applicationLimit: b.applicationLimit ?? null } }));
  }

  async setStatus(brandId: string, id: string, status: 'PUBLISHED' | 'CLOSED') {
    await this.owned(brandId, id);
    return this.view(await this.prisma.opportunity.update({ where: { id }, data: { status } }));
  }

  /** Brand: its briefs with application/invitation counts and how many slots remain. */
  async mine(brandId: string) {
    const rows = await this.prisma.opportunity.findMany({ where: { brandId }, orderBy: { createdAt: 'desc' } });
    const counts = await this.prisma.interest.groupBy({ by: ['opportunityId', 'senderId'], where: { brandId, opportunityId: { in: rows.map((r) => r.id) } }, _count: true });
    return rows.map((o) => {
      const applications = counts.filter((c) => c.opportunityId === o.id && c.senderId !== brandId).reduce((n, c) => n + c._count, 0);
      const invitations = counts.filter((c) => c.opportunityId === o.id && c.senderId === brandId).reduce((n, c) => n + c._count, 0);
      return { ...this.view(o), applications, invitations, slotsLeft: o.applicationLimit == null ? null : Math.max(0, o.applicationLimit - applications) };
    });
  }

  /**
   * Creator feed: public, published briefs that still have application slots, plus private briefs
   * they were invited to. Briefs they already applied to are left out.
   */
  async feed(creatorId: string) {
    const mine = await this.prisma.interest.findMany({ where: { creatorId }, select: { opportunityId: true, senderId: true } });
    const applied = new Set(mine.filter((i) => i.senderId === creatorId).map((i) => i.opportunityId));
    const invitedTo = mine.filter((i) => i.senderId !== creatorId).map((i) => i.opportunityId).filter((x): x is string => !!x);
    const rows = await this.prisma.opportunity.findMany({
      where: { status: 'PUBLISHED', OR: [{ visibility: 'PUBLIC' }, { id: { in: invitedTo } }] },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const full = await this.fullIds(rows);
    const brands = await this.prisma.brandProfile.findMany({ where: { userId: { in: rows.map((r) => r.brandId) } } });
    return rows
      .filter((o) => !applied.has(o.id) && (!full.has(o.id) || invitedTo.includes(o.id)))
      .map((o) => ({ ...this.view(o), brand: brands.find((b) => b.userId === o.brandId) ?? null, invited: invitedTo.includes(o.id) }));
  }

  async one(u: AuthUser, id: string) {
    const o = await this.prisma.opportunity.findUnique({ where: { id } });
    if (!o) throw new NotFoundException('Campaign brief not found');
    if (o.brandId !== u.id && o.visibility === 'PRIVATE') {
      const invited = await this.prisma.interest.findFirst({ where: { opportunityId: id, creatorId: u.id } });
      if (!invited) throw new NotFoundException('Campaign brief not found');
    }
    const brand = await this.prisma.brandProfile.findUnique({ where: { userId: o.brandId } });
    return { ...this.view(o), brand };
  }

  /** Creator applies to a public brief. The cap is enforced here; a full brief stops taking applications. */
  async apply(creatorId: string, id: string, message: string) {
    const o = await this.prisma.opportunity.findUnique({ where: { id } });
    if (!o || o.status !== 'PUBLISHED') throw new NotFoundException('This campaign is not open');
    if (o.visibility === 'PRIVATE') throw new ConflictException('This campaign is invite-only');
    if (o.applicationLimit != null) {
      const count = await this.prisma.interest.count({ where: { opportunityId: id, senderId: { not: o.brandId } } });
      if (count >= o.applicationLimit) throw new ConflictException('Applications are closed: this campaign reached its limit');
    }
    const key = { brandId_creatorId_scopeKey: { brandId: o.brandId, creatorId, scopeKey: id } };
    const existing = await this.prisma.interest.findUnique({ where: key });
    if (existing && existing.status !== 'EXPIRED' && existing.status !== 'DECLINED') throw new ConflictException('You already applied to this campaign');
    const expiresAt = new Date(Date.now() + INTEREST_TTL_DAYS * 864e5);
    const interest = await this.prisma.interest.upsert({
      where: key,
      create: { brandId: o.brandId, creatorId, senderId: creatorId, opportunityId: id, scopeKey: id, message, expiresAt },
      update: { status: 'PENDING', senderId: creatorId, message, expiresAt },
    });
    const creator = await this.prisma.creatorProfile.findUnique({ where: { userId: creatorId } });
    await this.notifications.notify(o.brandId, {
      kind: 'interest',
      title: `New application: ${o.title}`,
      body: `${creator?.displayName ?? 'A creator'}: ${message.slice(0, 120)}`,
      linkTo: '/(tabs)/(brand)/matches',
    });
    return interest;
  }

  private async fullIds(rows: Opportunity[]) {
    const capped = rows.filter((r) => r.applicationLimit != null);
    if (!capped.length) return new Set<string>();
    const counts = await this.prisma.interest.groupBy({ by: ['opportunityId'], where: { opportunityId: { in: capped.map((r) => r.id) }, NOT: { senderId: { in: capped.map((r) => r.brandId) } } }, _count: true });
    return new Set(capped.filter((r) => (counts.find((c) => c.opportunityId === r.id)?._count ?? 0) >= r.applicationLimit!).map((r) => r.id));
  }

  private async owned(brandId: string, id: string) {
    const o = await this.prisma.opportunity.findUnique({ where: { id } });
    if (!o || o.brandId !== brandId) throw new NotFoundException('Campaign brief not found');
    return o;
  }

  private view(o: Opportunity) {
    return { ...o, budgetNgn: o.budgetKobo / 100 };
  }
}

@Controller('opportunities')
@UseGuards(OnboardedGuard)
class OpportunitiesController {
  constructor(private readonly opps: OpportunitiesService) {}

  @Roles('BRAND')
  @Post()
  create(@CurrentUser() u: AuthUser, @Body(new ZodPipe(briefSchema)) b: BriefInput) {
    return this.opps.create(u.id, b);
  }

  @Roles('BRAND')
  @Get('mine')
  mine(@CurrentUser() u: AuthUser) {
    return this.opps.mine(u.id);
  }

  @Roles('CREATOR')
  @Get('feed')
  feed(@CurrentUser() u: AuthUser) {
    return this.opps.feed(u.id);
  }

  @Get(':id')
  one(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.opps.one(u, id);
  }

  @Roles('BRAND')
  @Put(':id')
  update(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(briefSchema)) b: BriefInput) {
    return this.opps.update(u.id, id, b);
  }

  @Roles('BRAND')
  @Post(':id/publish')
  publish(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.opps.setStatus(u.id, id, 'PUBLISHED');
  }

  @Roles('BRAND')
  @Post(':id/close')
  close(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.opps.setStatus(u.id, id, 'CLOSED');
  }

  @Roles('CREATOR')
  @Post(':id/apply')
  apply(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(applySchema)) b: z.infer<typeof applySchema>) {
    return this.opps.apply(u.id, id, b.message);
  }
}

@Module({ controllers: [OpportunitiesController], providers: [OpportunitiesService], exports: [OpportunitiesService] })
export class OpportunitiesModule {}
