import { Body, ConflictException, Controller, Delete, Get, HttpCode, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, Roles, type AuthUser } from '../common/auth.decorators.js';
import { OnboardedGuard } from '../common/onboarded.guard.js';
import { ZodPipe } from '../common/zod.pipe.js';
import type { Prisma } from '../generated/prisma/client.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { toCreatorCard } from '../profiles/creator.mapper.js';

export const INTEREST_TTL_DAYS = 7;

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
});
type Filters = z.infer<typeof filtersSchema>;

const swipeSchema = z.object({ creatorId: z.string().uuid(), direction: z.enum(['LIKE', 'PASS']) });

@Injectable()
export class DiscoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async discover(brandId: string, f: Filters) {
    const swiped = await this.prisma.swipe.findMany({ where: { brandId }, select: { creatorId: true } });
    const socialFilter: Prisma.SocialAccountWhereInput = {
      ...(f.platform && { platform: f.platform }),
      ...((f.minFollowers !== undefined || f.maxFollowers !== undefined) && {
        followers: { gte: f.minFollowers, lte: f.maxFollowers },
      }),
      ...(f.minEngagement !== undefined && { engagementRate: { gte: f.minEngagement } }),
    };
    const rows = await this.prisma.creatorProfile.findMany({
      where: {
        userId: { notIn: swiped.map((s) => s.creatorId) },
        user: { status: 'ACTIVE', onboardedAt: { not: null } },
        // Booked creators are not offered for new campaigns unless explicitly asked for.
        availability: f.availability ?? { not: 'booked' },
        ...(f.category && { category: f.category }),
        ...(f.location && { location: { contains: f.location, mode: 'insensitive' } }),
        ...(f.budgetMaxNgn !== undefined && { priceFromKobo: { lte: f.budgetMaxNgn * 100 } }),
        ...(f.minCredibility !== undefined && { credibilityScore: { gte: f.minCredibility } }),
        ...(Object.keys(socialFilter).length && { socials: { some: socialFilter } }),
      },
      include: { socials: true },
      orderBy: [{ credibilityScore: 'desc' }, { userId: 'asc' }],
      take: f.limit,
    });
    return {
      items: rows.map(toCreatorCard),
      message: rows.length ? undefined : "We couldn't find creators matching your criteria. Try adjusting your filters.",
    };
  }

  /** A right swipe only records interest: no campaign, contract or payment (PRD 3.2). */
  async swipe(brandId: string, creatorId: string, direction: 'LIKE' | 'PASS') {
    const creator = await this.prisma.creatorProfile.findUnique({ where: { userId: creatorId } });
    if (!creator) throw new NotFoundException('Creator not found');
    await this.prisma.swipe.upsert({
      where: { brandId_creatorId: { brandId, creatorId } },
      create: { brandId, creatorId, direction },
      update: { direction },
    });
    if (direction === 'PASS') return { interest: null };

    const existing = await this.prisma.interest.findUnique({ where: { brandId_creatorId: { brandId, creatorId } } });
    if (existing && existing.status !== 'EXPIRED') return { interest: existing };
    const expiresAt = new Date(Date.now() + INTEREST_TTL_DAYS * 864e5);
    const interest = await this.prisma.interest.upsert({
      where: { brandId_creatorId: { brandId, creatorId } },
      create: { brandId, creatorId, senderId: brandId, expiresAt },
      update: { status: 'PENDING', expiresAt },
    });
    const brand = await this.prisma.brandProfile.findUnique({ where: { userId: brandId } });
    await this.notifications.notify(creatorId, {
      kind: 'interest',
      title: 'A brand is interested',
      body: `${brand?.businessName ?? 'A brand'} wants to work with you.`,
      linkTo: `/likes`,
    });
    return { interest };
  }

  /** Undo is only possible while the creator has not answered. */
  async undo(brandId: string, creatorId: string) {
    const key = { brandId_creatorId: { brandId, creatorId } };
    const interest = await this.prisma.interest.findUnique({ where: key });
    if (interest && interest.status !== 'PENDING') throw new ConflictException('Creator already responded');
    await this.prisma.$transaction([
      this.prisma.interest.deleteMany({ where: { brandId, creatorId } }),
      this.prisma.swipe.deleteMany({ where: { brandId, creatorId } }),
    ]);
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
    return this.discovery.swipe(u.id, b.creatorId, b.direction);
  }

  @Roles('BRAND')
  @HttpCode(204)
  @Delete('swipes/:creatorId')
  undo(@CurrentUser() u: AuthUser, @Param('creatorId', ParseUUIDPipe) creatorId: string) {
    return this.discovery.undo(u.id, creatorId);
  }
}

@Module({ controllers: [DiscoveryController], providers: [DiscoveryService] })
export class DiscoveryModule {}
