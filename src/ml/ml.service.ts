import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthUser } from '../common/auth.decorators.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MlClient } from './ml.client.js';
import { MlSyncService } from './ml-sync.service.js';
import {
  mapCreatorToMl,
  mapEvidenceToMl,
  mapOpportunityToMl,
  type RecommendationCreator,
} from './ml.mapper.js';
import type { RecommendationInput } from './ml.schemas.js';
import { campaignEvidence } from './campaign-evidence.js';

const creatorInclude = {
  creator: { include: { user: true, socials: true } },
  audienceMarkets: true,
  deliverableCapabilities: true,
  commercialRates: true,
} as const;

@Injectable()
export class MlService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly client: MlClient,
    private readonly sync: MlSyncService,
  ) {}

  async recommend(
    brandId: string,
    opportunityId: string,
    input: RecommendationInput,
    requestId?: string,
    /** Creators to leave out before ranking (already swiped), so the top of the list is always new to the brand. */
    excludeCreatorIds: string[] = [],
  ) {
    const owned = await this.prisma.opportunity.findUnique({ where: { id: opportunityId }, select: { brandId: true, status: true } });
    if (!owned || owned.brandId !== brandId)
      throw new NotFoundException('Campaign brief not found');
    if (owned.status === 'CLOSED')
      throw new ConflictException('This campaign is closed');
    // Briefs are synced here rather than on save: this also covers briefs written before the sync existed,
    // and a brand's later industry change. Unchanged briefs are a hash comparison.
    const missing = await this.sync.syncOpportunity(opportunityId);
    await this.backfillCreators();
    const opportunity = await this.prisma.opportunity.findUniqueOrThrow({
      where: { id: opportunityId },
      include: { mlProfile: true },
    });
    if (!opportunity.mlProfile)
      throw new ConflictException(
        missing ?? 'This campaign does not have recommendation features yet',
      );

    const rows = await this.prisma.creatorMlProfile.findMany({
      where: {
        namespace: opportunity.mlProfile.namespace,
        ...(excludeCreatorIds.length && { creatorId: { notIn: excludeCreatorIds } }),
        creator: {
          availability: { not: 'booked' },
          user: {
            status: 'ACTIVE',
            onboardedAt: { not: null },
            openToInvites: true,
          },
        },
      },
      include: creatorInclude,
      orderBy: { sourceCreatorId: 'asc' },
      take: 500,
    });
    const response = await this.client.recommend(
      {
        mode: input.mode,
        campaign: mapOpportunityToMl(opportunity),
        candidates: rows.map(mapCreatorToMl),
        limit: input.limit,
        include_excluded: input.includeExcluded,
      },
      requestId,
    );

    const byId = new Map(rows.map((row) => [row.creatorId, row]));
    const credibility = input.includeCredibility
      ? await this.credibilityFor(
          response.recommendations.map((item) => item.creator_id),
          requestId,
        )
      : new Map();

    return {
      campaignId: opportunity.id,
      model: { mode: response.ranker, version: response.model_version },
      candidateCount: response.candidate_count,
      eligibleCount: response.eligible_count,
      excludedCount: response.excluded_count,
      organic: response.recommendations.map((item) => ({
        ...item,
        creator: this.publicCreator(byId.get(item.creator_id)),
        credibility: credibility.get(item.creator_id) ?? null,
      })),
      sponsored: [],
      exclusions: response.exclusions,
      warnings: response.warnings,
      latencyMs: response.latency_ms,
    };
  }

  /**
   * Creators who have not saved their profile since the live sync existed have no ML profile yet, so they would
   * never be recommended. Fill those in, a bounded batch per request.
   * ponytail: request-time backfill; replace with a one-off `npm run ml:enrich` once production has been enriched.
   */
  private async backfillCreators() {
    const pending = await this.prisma.creatorProfile.findMany({
      where: { mlProfile: null, user: { status: 'ACTIVE', onboardedAt: { not: null }, openToInvites: true } },
      select: { userId: true },
      take: 100,
    });
    for (const { userId } of pending) await this.sync.syncCreator(userId);
  }

  async credibility(user: AuthUser, creatorId: string, requestId?: string) {
    const profile = await this.prisma.creatorProfile.findUnique({
      where: { userId: creatorId },
      include: { user: true, mlProfile: true },
    });
    const visible =
      profile &&
      (user.role === 'ADMIN' ||
        user.id === creatorId ||
        (user.role === 'BRAND' &&
          profile.user.status === 'ACTIVE' &&
          !!profile.user.onboardedAt &&
          profile.user.openToInvites));
    if (!visible) throw new NotFoundException('Creator not found');
    const events = profile.mlProfile
      ? await this.eventsFor(profile.mlProfile.id)
      : [];
    const real = await this.realEvidence([creatorId]);
    return this.client.credibility(
      { creator_id: creatorId, events: [...mapEvidenceToMl(creatorId, events), ...(real.get(creatorId) ?? [])] },
      requestId,
    );
  }

  private async credibilityFor(creatorIds: string[], requestId?: string) {
    if (!creatorIds.length) return new Map();
    const profiles = await this.prisma.creatorMlProfile.findMany({
      where: { creatorId: { in: creatorIds } },
      select: { id: true, creatorId: true },
    });
    const events = await this.prisma.demoMlEvidenceEvent.findMany({
      where: { creatorMlProfileId: { in: profiles.map((row) => row.id) } },
      include: { opportunityMlProfile: true },
      orderBy: [
        { occurredAt: 'asc' },
        { sourceJourneyId: 'asc' },
        { sequence: 'asc' },
      ],
    });
    const real = await this.realEvidence(creatorIds);
    const requests = creatorIds.map((creatorId) => {
      const profileIds = new Set(
        profiles
          .filter((row) => row.creatorId === creatorId)
          .map((row) => row.id),
      );
      return {
        creator_id: creatorId,
        events: [
          ...mapEvidenceToMl(
            creatorId,
            events.filter((row) => profileIds.has(row.creatorMlProfileId)),
          ),
          ...(real.get(creatorId) ?? []),
        ],
      };
    });
    const results = await this.client.credibilityBatch(
      { creators: requests },
      requestId,
    );
    return new Map(results.map((result) => [result.creator_id, result]));
  }

  /**
   * How well one creator fits each brief, from the same model and hard rules brands see (0-1), or the rule they miss
   * (`outside`). Briefs that cannot be scored (no platform named in their deliverables) are absent. Returns null when
   * the creator cannot be scored at all (no ML profile yet), so callers fall back to an unscored list.
   * ponytail: one model call per brief, 8 at a time; add a batch endpoint to the ML service if the feed grows past ~100.
   */
  async scoreBriefsFor(creatorId: string, opportunityIds: string[], requestId?: string) {
    const scores = new Map<string, { score: number; matched: string[] } | { outside: string }>();
    await this.sync.syncCreator(creatorId);
    const creator = await this.prisma.creatorMlProfile.findUnique({ where: { creatorId }, include: creatorInclude });
    if (!creator) return null;
    for (const id of opportunityIds) await this.sync.syncOpportunity(id);
    const briefs = await this.prisma.opportunity.findMany({ where: { id: { in: opportunityIds } }, include: { mlProfile: true } });
    const queue = briefs.filter((o) => o.mlProfile?.namespace === creator.namespace);
    const worker = async () => {
      for (let o = queue.shift(); o; o = queue.shift()) {
        const r = await this.client.recommend(
          { mode: 'structured', campaign: mapOpportunityToMl(o), candidates: [mapCreatorToMl(creator)], limit: 1, include_excluded: true },
          requestId,
        );
        const top = r.recommendations[0];
        const miss = r.exclusions[0];
        scores.set(o.id, top ? { score: top.score, matched: matchedParts(top.explanation.components) } : { outside: outsideLabel(miss?.exclusion_reasons ?? [], 'creator') });
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    return scores;
  }

  /** Finished campaigns in the app, as credibility evidence, per creator. */
  private async realEvidence(creatorIds: string[]) {
    const campaigns = await this.prisma.campaign.findMany({
      where: { creatorId: { in: creatorIds } },
      select: {
        id: true, creatorId: true, status: true, createdAt: true, fundedAt: true, completedAt: true, updatedAt: true,
        submissions: { select: { late: true, superseded: true, createdAt: true } },
        disputes: { select: { status: true, createdAt: true, resolvedAt: true } },
      },
    });
    const byCreator = new Map<string, Record<string, unknown>[]>();
    for (const c of campaigns) byCreator.set(c.creatorId, [...(byCreator.get(c.creatorId) ?? []), ...campaignEvidence(c)]);
    return byCreator;
  }

  private eventsFor(creatorMlProfileId: string) {
    return this.prisma.demoMlEvidenceEvent.findMany({
      where: { creatorMlProfileId },
      include: { opportunityMlProfile: true },
      orderBy: [
        { occurredAt: 'asc' },
        { sourceJourneyId: 'asc' },
        { sequence: 'asc' },
      ],
    });
  }

  private publicCreator(row?: RecommendationCreator) {
    if (!row) return null;
    return {
      id: row.creatorId,
      displayName: row.creator.displayName,
      avatarUrl: row.displayImageOverrideUrl ?? row.creator.avatarUrl,
      bio: row.creator.bio,
      location: row.creator.location,
      category: row.creator.category,
      niches: row.creator.niches,
      availability: row.creator.availability,
      platforms: row.creator.socials.map((social) => social.platform),
    };
  }
}

const PLATFORM: Record<string, string> = { tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube', x: 'X', facebook: 'Facebook' };
const plat = (p: string) => PLATFORM[p] ?? p;

/**
 * The recommender's hard-rule reasons (eligibility.py) in plain words, from the reader's side: why this creator is
 * outside this brief. Only the first reason is shown; budget comes last because it is the most negotiable.
 */
export function outsideLabel(reasons: string[], side: 'brand' | 'creator') {
  const brand = side === 'brand';
  for (const r of reasons) {
    const [kind, a, b] = r.split(':');
    if (kind === 'missing_required_platform' || kind === 'missing_required_format') return brand ? `No ${plat(a)} ${b ? `${b} ` : ''}on their profile` : `Needs ${plat(a)} on your profile`;
    if (kind === 'missing_commercial_rate') return brand ? `No ${plat(a)} rate set yet` : `Add your ${plat(a)} rate to your profile`;
    if (kind === 'missing_required_content_language') return brand ? `Doesn't post in ${a}` : `Needs content in ${a}`;
  }
  if (reasons.includes('over_budget')) return brand ? 'Rate above this brief’s budget' : 'Your rate is above its budget';
  return brand ? 'Outside this brief' : 'Outside your profile';
}

/** Which parts of a brief a creator matches (niche, category, ...), strongest first. */
export const matchedParts = (components: Record<string, number>) =>
  Object.entries(components).filter(([, v]) => v > 0).sort(([, a], [, b]) => b - a).map(([k]) => k);
