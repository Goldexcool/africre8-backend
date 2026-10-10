import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthUser } from '../common/auth.decorators.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MlClient } from './ml.client.js';
import {
  mapCreatorToMl,
  mapEvidenceToMl,
  mapOpportunityToMl,
  type RecommendationCreator,
} from './ml.mapper.js';
import type { RecommendationInput } from './ml.schemas.js';

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
  ) {}

  async recommend(
    brandId: string,
    opportunityId: string,
    input: RecommendationInput,
    requestId?: string,
  ) {
    const opportunity = await this.prisma.opportunity.findUnique({
      where: { id: opportunityId },
      include: { mlProfile: true },
    });
    if (!opportunity || opportunity.brandId !== brandId)
      throw new NotFoundException('Campaign brief not found');
    if (opportunity.status === 'CLOSED')
      throw new ConflictException('This campaign is closed');
    if (!opportunity.mlProfile)
      throw new ConflictException(
        'This campaign does not have recommendation features yet',
      );

    const rows = await this.prisma.creatorMlProfile.findMany({
      where: {
        namespace: opportunity.mlProfile.namespace,
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
    return this.client.credibility(
      { creator_id: creatorId, events: mapEvidenceToMl(creatorId, events) },
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
    const requests = creatorIds.map((creatorId) => {
      const profileIds = new Set(
        profiles
          .filter((row) => row.creatorId === creatorId)
          .map((row) => row.id),
      );
      return {
        creator_id: creatorId,
        events: mapEvidenceToMl(
          creatorId,
          events.filter((row) => profileIds.has(row.creatorMlProfileId)),
        ),
      };
    });
    const results = await this.client.credibilityBatch(
      { creators: requests },
      requestId,
    );
    return new Map(results.map((result) => [result.creator_id, result]));
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
