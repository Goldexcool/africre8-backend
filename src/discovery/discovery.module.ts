import { Body, ConflictException, Controller, Delete, Get, HttpCode, HttpException, Injectable, Logger, Module, NotFoundException, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, Roles, type AuthUser } from '../common/auth.decorators.js';
import { OnboardedGuard } from '../common/onboarded.guard.js';
import { ZodPipe } from '../common/zod.pipe.js';
import type { Prisma } from '../generated/prisma/client.js';
import { MlModule } from '../ml/ml.module.js';
import { MlService, matchedParts } from '../ml/ml.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { toCreatorCard } from '../profiles/creator.mapper.js';

export const INTEREST_TTL_DAYS = 7;
/** A card is only offered when the recommender rates the fit at least this high (0-1), so every queue ends. */
export const MIN_MATCH = 0.3;

const num = z.coerce.number().optional();
const filtersSchema = z.object({
  category: z.string().optional(),
  location: z.string().optional(),
  platform: z.enum(['instagram', 'tiktok', 'youtube', 'x', 'facebook']).optional(),
  minFollowers: num,
  maxFollowers: num,
  minEngagement: num,
  budgetMaxNgn: num,
  minCredibility: num,
  availability: z.enum(['available', 'busy', 'booked']).optional(),
  limit: z.coerce.number().min(1).max(50).default(20),
  /** The brief the brand is hiring for; swipes and invites are recorded against it. */
  opportunityId: z.string().uuid().optional(),
});
type Filters = z.infer<typeof filtersSchema>;

const swipeSchema = z.object({
  creatorId: z.string().uuid(),
  direction: z.enum(['LIKE', 'PASS']),
  opportunityId: z.string().uuid().optional(),
  message: z.string().trim().max(1000).optional(),
});
const bulkSchema = z.object({
  creatorIds: z.array(z.string().uuid()).min(1).max(50),
  opportunityId: z.string().uuid().optional(),
  message: z.string().trim().min(1).max(1000),
});
const scope = (opportunityId?: string) => opportunityId ?? 'general';

@Injectable()
export class DiscoveryService {
  private readonly log = new Logger(DiscoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly ml: MlService,
  ) {}

  /**
   * Creators for the deck. With a brief, only creators the recommender rates at least MIN_MATCH, best first, each with
   * their match and model credibility; the deck ends when they have all been swiped. When the recommender cannot rank
   * (no platform in the brief, ML service down) the usual order is used and `ranking` says why.
   */
  async discover(brandId: string, f: Filters) {
    if (!f.opportunityId) return { ...(await this.plain(brandId, f)), ranking: { source: 'default' as const } };
    let recommended: Awaited<ReturnType<MlService['recommend']>>['organic'] = [];
    let note: string | undefined;
    let model: { mode: string; version: string } | undefined;
    try {
      const swiped = await this.swipedIds(brandId, f.opportunityId);
      const r = await this.ml.recommend(brandId, f.opportunityId, { mode: 'structured', limit: 100, includeExcluded: false, includeCredibility: true }, undefined, swiped);
      recommended = r.organic.filter((x) => x.score >= MIN_MATCH);
      model = r.model;
    } catch (e) {
      if (e instanceof NotFoundException) throw e; // not this brand's brief
      note = e instanceof HttpException && e.getStatus() < 500 ? e.message : 'Recommendations are unavailable right now, so creators are shown in the usual order.';
      if (!(e instanceof HttpException) || e.getStatus() >= 500) this.log.warn(`recommendations for ${f.opportunityId}: ${(e as Error).message}`);
      return { ...(await this.plain(brandId, f)), ranking: { source: 'default' as const, note } };
    }
    // Credibility is the model's (real campaign evidence); creators without any yet ("New") only pass a 0 minimum.
    if (f.minCredibility) recommended = recommended.filter((r) => (r.credibility?.credibility_score ?? -1) >= f.minCredibility!);
    const { minCredibility: _, ...rest } = f;
    const base = await this.plain(brandId, { ...rest, limit: 50 }, recommended.map((r) => r.creator_id), true);
    const byId = new Map(recommended.map((r) => [r.creator_id, r]));
    const ranked = base.items
      .filter((card) => byId.has(card.id))
      .map((card) => {
        const r = byId.get(card.id)!;
        return {
          ...card,
          match: {
            rank: r.rank,
            score: r.score,
            summary: r.explanation.summary,
            matched: matchedParts(r.explanation.components),
            credibility: r.credibility ? { status: r.credibility.status, score: r.credibility.credibility_score, tier: r.credibility.evidence_tier } : null,
          },
        };
      })
      .sort((a, b) => a.match.rank - b.match.rank)
      .slice(0, f.limit);
    return {
      items: ranked,
      message: ranked.length ? undefined : "You've seen every creator who matches this brief. New matches appear as creators join or update their profiles.",
      ranking: { source: 'recommender' as const, model, minMatch: MIN_MATCH },
    };
  }

  private async swipedIds(brandId: string, opportunityId?: string) {
    const rows = await this.prisma.swipe.findMany({ where: { brandId, scopeKey: scope(opportunityId) }, select: { creatorId: true } });
    return rows.map((s) => s.creatorId);
  }

  /** The filtered pool, best credibility first; `extra` creators (the recommended ones) are always included if they fit, `onlyExtra` returns just them. */
  private async plain(brandId: string, f: Filters, extra: string[] = [], onlyExtra = false) {
    const swiped = (await this.swipedIds(brandId, f.opportunityId)).map((creatorId) => ({ creatorId }));
    const socialFilter: Prisma.SocialAccountWhereInput = {
      ...(f.platform && { platform: f.platform }),
      ...((f.minFollowers !== undefined || f.maxFollowers !== undefined) && {
        followers: { gte: f.minFollowers, lte: f.maxFollowers },
      }),
      ...(f.minEngagement !== undefined && { engagementRate: { gte: f.minEngagement } }),
    };
    const where: Prisma.CreatorProfileWhereInput = {
      userId: { notIn: swiped.map((s) => s.creatorId) },
      user: { status: 'ACTIVE', onboardedAt: { not: null }, openToInvites: true },
      // Booked creators are not offered for new campaigns unless explicitly asked for.
      availability: f.availability ?? { not: 'booked' },
      ...(f.category && { category: f.category }),
      ...(f.location && { location: { contains: f.location, mode: 'insensitive' } }),
      ...(f.budgetMaxNgn !== undefined && { priceFromKobo: { lte: f.budgetMaxNgn * 100 } }),
      ...(f.minCredibility !== undefined && { credibilityScore: { gte: f.minCredibility } }),
      ...(Object.keys(socialFilter).length && { socials: { some: socialFilter } }),
    };
    const include = { socials: true, mlProfile: { select: { displayImageOverrideUrl: true } } } as const;
    const [picked, page] = await Promise.all([
      extra.length ? this.prisma.creatorProfile.findMany({ where: { AND: [where, { userId: { in: extra } }] }, include }) : [],
      onlyExtra ? [] : this.prisma.creatorProfile.findMany({ where, include, orderBy: [{ credibilityScore: 'desc' }, { userId: 'asc' }], take: f.limit }),
    ]);
    const rows = [...picked, ...page.filter((p) => !picked.some((x) => x.userId === p.userId))];
    return {
      items: rows.map(toCreatorCard),
      message: rows.length ? undefined : "We couldn't find creators matching your criteria. Try adjusting your filters.",
    };
  }

  /** A right swipe only records interest: no campaign, contract or payment (PRD 3.2). */
  async swipe(brandId: string, creatorId: string, direction: 'LIKE' | 'PASS', opportunityId?: string, message?: string) {
    const creator = await this.prisma.creatorProfile.findUnique({ where: { userId: creatorId } });
    if (!creator) throw new NotFoundException('Creator not found');
    const opp = opportunityId ? await this.ownedOpportunity(brandId, opportunityId) : null;
    const scopeKey = scope(opportunityId);
    await this.prisma.swipe.upsert({
      where: { brandId_creatorId_scopeKey: { brandId, creatorId, scopeKey } },
      create: { brandId, creatorId, direction, scopeKey },
      update: { direction },
    });
    if (direction === 'PASS') return { interest: null };

    const key = { brandId_creatorId_scopeKey: { brandId, creatorId, scopeKey } };
    const existing = await this.prisma.interest.findUnique({ where: key });
    if (existing && existing.status !== 'EXPIRED') return { interest: existing };
    const expiresAt = new Date(Date.now() + INTEREST_TTL_DAYS * 864e5);
    const interest = await this.prisma.interest.upsert({
      where: key,
      create: { brandId, creatorId, senderId: brandId, expiresAt, opportunityId, scopeKey, message },
      update: { status: 'PENDING', expiresAt, message },
    });
    const brand = await this.prisma.brandProfile.findUnique({ where: { userId: brandId } });
    await this.notifications.notify(creatorId, {
      kind: 'interest',
      title: opp ? `Invitation: ${opp.title}` : 'New invitation',
      body: message ? `${brand?.businessName ?? 'A brand'}: ${message.slice(0, 120)}` : `${brand?.businessName ?? 'A brand'} invited you to work together.`,
      linkTo: `/likes`,
    });
    return { interest };
  }

  /** Stack send: invite many creators to one brief with one message. Already-invited creators are skipped. */
  async bulk(brandId: string, creatorIds: string[], message: string, opportunityId?: string) {
    const results: { creatorId: string; interestId?: string; error?: string }[] = [];
    for (const creatorId of new Set(creatorIds)) {
      try {
        const { interest } = await this.swipe(brandId, creatorId, 'LIKE', opportunityId, message);
        results.push({ creatorId, interestId: interest?.id });
      } catch (e) {
        results.push({ creatorId, error: (e as Error).message });
      }
    }
    return { sent: results.filter((r) => r.interestId).length, results };
  }

  /** Undo is only possible while the creator has not answered. */
  async undo(brandId: string, creatorId: string, opportunityId?: string) {
    const scopeKey = scope(opportunityId);
    const interest = await this.prisma.interest.findUnique({ where: { brandId_creatorId_scopeKey: { brandId, creatorId, scopeKey } } });
    if (interest && interest.status !== 'PENDING') throw new ConflictException('Creator already responded');
    await this.prisma.$transaction([
      this.prisma.interest.deleteMany({ where: { brandId, creatorId, scopeKey } }),
      this.prisma.swipe.deleteMany({ where: { brandId, creatorId, scopeKey } }),
    ]);
  }

  private async ownedOpportunity(brandId: string, id: string) {
    const opp = await this.prisma.opportunity.findUnique({ where: { id } });
    if (!opp || opp.brandId !== brandId) throw new NotFoundException('Campaign brief not found');
    if (opp.status === 'CLOSED') throw new ConflictException('This campaign brief is closed');
    return opp;
  }
}

@Controller()
@UseGuards(OnboardedGuard)
class DiscoveryController {
  constructor(private readonly discovery: DiscoveryService) {}

  @Roles('BRAND')
  @Get('discover')
  discover(@CurrentUser() u: AuthUser, @Query(new ZodPipe(filtersSchema)) f: Filters) {
    return this.discovery.discover(u.id, f);
  }

  @Roles('BRAND')
  @Post('swipes')
  swipe(@CurrentUser() u: AuthUser, @Body(new ZodPipe(swipeSchema)) b: z.infer<typeof swipeSchema>) {
    return this.discovery.swipe(u.id, b.creatorId, b.direction, b.opportunityId, b.message);
  }

  @Roles('BRAND')
  @Post('interests/bulk')
  bulk(@CurrentUser() u: AuthUser, @Body(new ZodPipe(bulkSchema)) b: z.infer<typeof bulkSchema>) {
    return this.discovery.bulk(u.id, b.creatorIds, b.message, b.opportunityId);
  }

  @Roles('BRAND')
  @HttpCode(204)
  @Delete('swipes/:creatorId')
  undo(@CurrentUser() u: AuthUser, @Param('creatorId', ParseUUIDPipe) creatorId: string, @Query('opportunityId') opportunityId?: string) {
    return this.discovery.undo(u.id, creatorId, opportunityId);
  }
}

@Module({ imports: [MlModule], controllers: [DiscoveryController], providers: [DiscoveryService] })
export class DiscoveryModule {}
