import { Controller, Get, Header, Module } from '@nestjs/common';
import { Public } from '../common/auth.decorators.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** The niches creators and briefs are filed under. Real data adds to this list (see `filters`). */
export const CATEGORIES = [
  'Fashion & Lifestyle',
  'Beauty',
  'Food & Culinary',
  'Tech & Gadgets',
  'Fitness',
  'Music',
  'Comedy & Skits',
  'Travel',
  'Finance & Fintech',
  'Gaming',
  'Art & Design',
  'Parenting',
];

const PLATFORMS = ['instagram', 'tiktok', 'youtube', 'x', 'facebook'] as const;
const AVAILABILITY = ['available', 'busy', 'booked'] as const;
/** Presets for the Discover filter sheet. `max: null` means "no upper bound". */
const FOLLOWER_BANDS = [
  { label: 'Micro <10K', min: 0, max: 10_000 },
  { label: 'Mid 10K–100K', min: 10_000, max: 100_000 },
  { label: 'Macro 100K+', min: 100_000, max: null },
];
const ENGAGEMENT_MIN = [2, 5, 8];
const CREDIBILITY_MIN = [70, 85, 90];
const BUDGET_MAX_NGN = [50_000, 150_000, 500_000, 1_500_000, 5_000_000];

const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort((a, b) => a.localeCompare(b));

/**
 * Options for filter sheets and forms, in one place so the app never hard-codes lists. Public and
 * user-independent, so it is cacheable for an hour (the app also keeps it on disk for a day).
 */
@Public()
@Controller('meta')
export class MetaController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('filters')
  @Header('Cache-Control', 'public, max-age=3600')
  async filters() {
    const profiles = await this.prisma.creatorProfile.findMany({ select: { category: true, location: true } });
    return {
      categories: sorted([...CATEGORIES, ...profiles.map((p) => p.category).filter((c): c is string => !!c)]),
      locations: sorted(profiles.map((p) => p.location).filter((l): l is string => !!l)),
      platforms: PLATFORMS,
      availability: AVAILABILITY,
      followerBands: FOLLOWER_BANDS,
      engagementMin: ENGAGEMENT_MIN,
      credibilityMin: CREDIBILITY_MIN,
      budgetMaxNgn: BUDGET_MAX_NGN,
    };
  }
}

@Module({ controllers: [MetaController] })
export class MetaModule {}
