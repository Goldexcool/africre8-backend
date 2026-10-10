import { Body, ConflictException, Controller, Delete, Get, HttpCode, Injectable, Logger, Module, NotFoundException, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, Roles, type AuthUser } from '../common/auth.decorators.js';
import { OnboardedGuard } from '../common/onboarded.guard.js';
import { ZodPipe } from '../common/zod.pipe.js';
import type { Opportunity } from '../generated/prisma/client.js';
import { MIN_MATCH } from '../discovery/discovery.module.js';
import { MlModule } from '../ml/ml.module.js';
import { MlService } from '../ml/ml.service.js';
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
/**
 * A creator's pass on a brief, kept in the Swipe table under its own scope so it never mixes with the brand's swipes.
 * ponytail: reuses Swipe to avoid a migration; give creator passes their own table if they ever need more fields.
 */
const passScope = (opportunityId: string) => `creator-pass:${opportunityId}`;

@Injectable()
export class OpportunitiesService {
  private readonly log = new Logger(OpportunitiesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly ml: MlService,
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
   * Creator feed: published briefs that fit this creator at least MIN_MATCH (scored by the same recommender brands use),
   * best fit first, plus private briefs they were invited to. Briefs they applied to or passed on are left out, so the
   * queue ends. If the recommender is down the briefs come unscored, newest first, and `match` is null.
   */
  async feed(creatorId: string) {
    const mine = await this.prisma.interest.findMany({ where: { creatorId }, select: { opportunityId: true, senderId: true } });
    const applied = new Set(mine.filter((i) => i.senderId === creatorId).map((i) => i.opportunityId));
    const invitedTo = mine.filter((i) => i.senderId !== creatorId).map((i) => i.opportunityId).filter((x): x is string => !!x);
    const passes = await this.prisma.swipe.findMany({ where: { creatorId, scopeKey: { startsWith: passScope('') } }, select: { scopeKey: true } });
    const passed = new Set(passes.map((p) => p.scopeKey.slice(passScope('').length)));
    const rows = await this.prisma.opportunity.findMany({
      where: { status: 'PUBLISHED', OR: [{ visibility: 'PUBLIC' }, { id: { in: invitedTo } }] },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const full = await this.fullIds(rows);
    const open = rows.filter((o) => !applied.has(o.id) && !passed.has(o.id) && (!full.has(o.id) || invitedTo.includes(o.id)));
    let scores: Map<string, { score: number; matched: string[] } | null> | null = null;
    try {
      scores = await this.ml.scoreBriefsFor(creatorId, open.map((o) => o.id));
    } catch (e) {
      this.log.warn(`feed scores for ${creatorId}: ${(e as Error).message}`);
    }
    const brands = await this.prisma.brandProfile.findMany({ where: { userId: { in: open.map((r) => r.brandId) } } });
    return open
      .map((o) => ({ ...this.view(o), brand: brands.find((b) => b.userId === o.brandId) ?? null, invited: invitedTo.includes(o.id), match: scores?.get(o.id) ?? null }))
      .filter((o) => !scores || o.invited || (o.match?.score ?? 0) >= MIN_MATCH)
      .sort((a, b) => Number(b.invited) - Number(a.invited) || (b.match?.score ?? 0) - (a.match?.score ?? 0));
  }

  /** The creator is not interested in this brief: it leaves their feed. */
  async pass(creatorId: string, id: string) {
    const o = await this.prisma.opportunity.findUnique({ where: { id }, select: { brandId: true } });
    if (!o) throw new NotFoundException('Campaign brief not found');
    const scopeKey = passScope(id);
    await this.prisma.swipe.upsert({
      where: { brandId_creatorId_scopeKey: { brandId: o.brandId, creatorId, scopeKey } },
      create: { brandId: o.brandId, creatorId, direction: 'PASS', scopeKey },
      update: {},
    });
  }

  async unpass(creatorId: string, id: string) {
    await this.prisma.swipe.deleteMany({ where: { creatorId, scopeKey: passScope(id) } });
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

  @Roles('CREATOR')
  @HttpCode(204)
  @Post(':id/pass')
  pass(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.opps.pass(u.id, id);
  }

  @Roles('CREATOR')
  @HttpCode(204)
  @Delete(':id/pass')
  unpass(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.opps.unpass(u.id, id);
  }
}

@Module({ imports: [MlModule], controllers: [OpportunitiesController], providers: [OpportunitiesService], exports: [OpportunitiesService] })
export class OpportunitiesModule {}
