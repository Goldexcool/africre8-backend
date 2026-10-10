import { InternalServerErrorException } from '@nestjs/common';
import { z } from 'zod';
import type { Prisma } from '../generated/prisma/client.js';
import { eventTypeSchema } from './ml.schemas.js';

export type RecommendationCreator = Prisma.CreatorMlProfileGetPayload<{
  include: {
    creator: { include: { user: true; socials: true } };
    audienceMarkets: true;
    deliverableCapabilities: true;
    commercialRates: true;
  };
}>;

export type RecommendationOpportunity = Prisma.OpportunityGetPayload<{
  include: { mlProfile: true };
}>;
export type CredibilityEvent = Prisma.DemoMlEvidenceEventGetPayload<{
  include: { opportunityMlProfile: true };
}>;

const deliverableSchema = z
  .array(
    z
      .object({
        platform: z.string().min(1),
        format: z.string().min(1),
        quantity: z.number().int().min(1).max(100),
      })
      .strict(),
  )
  .min(1);

const usageRightsSchema = z
  .object({
    paid_usage: z.boolean(),
    category_exclusivity_days: z.number().int().nonnegative(),
    organic_days: z.number().int().nonnegative().optional(),
  })
  .strict();

const jsonObject = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new InternalServerErrorException(`Invalid imported ${label}`);
  return value as Record<string, unknown>;
};

export function mapCreatorToMl(row: RecommendationCreator) {
  return {
    id: row.creatorId,
    bio: row.creator.bio ?? '',
    category: row.creator.category ?? '',
    portfolio_description: row.portfolioDescription ?? '',
    content_tone: row.contentTone ?? '',
    niches: row.creator.niches,
    audience_interests: row.audienceInterests,
    creative_styles: row.creativeStyles,
    production_capabilities: row.productionCapabilities,
    content_languages: row.contentLanguages,
    deliverable_capabilities: row.deliverableCapabilities.map((item) => ({
      platform: item.platform,
      format: item.format,
    })),
    commercial_rates: row.commercialRates.map((item) => ({
      platform: item.platform,
      format: item.format,
      base_rate: {
        amount: item.amount.toFixed(2),
        currency: item.currency,
        normalized_usd: item.normalizedUsd.toFixed(2),
        rate_version: item.rateVersion,
        purpose: item.purpose,
      },
      usage_rights_multiplier: jsonObject(
        item.usageRightsMultipliers,
        'usage-rights multipliers',
      ),
      category_exclusivity_30_days_multiplier:
        item.categoryExclusivity30DaysMultiplier.toString(),
      includes: item.includes,
    })),
    audience: {
      markets: row.audienceMarkets.map((item) => ({
        country_code: item.countryCode,
        share_percent: Number(item.sharePercent),
      })),
      interests: row.audienceInterests,
    },
  };
}

export function mapOpportunityToMl(row: RecommendationOpportunity) {
  const ml = row.mlProfile;
  if (!ml)
    throw new InternalServerErrorException(
      'Campaign ML profile is unavailable',
    );
  const deliverables = deliverableSchema.parse(ml.deliverables);
  const usageRights = usageRightsSchema.parse(ml.usageRights);
  return {
    id: row.id,
    title: row.title,
    brief: row.brief,
    category: row.category,
    industry: ml.industry ?? '',
    product: ml.product ?? '',
    objective: ml.objective ?? '',
    tone: ml.tone ?? '',
    creative_concept: ml.creativeConcept ?? '',
    key_messages: ml.keyMessages,
    compatible_niches: ml.compatibleNiches,
    preferred_languages: ml.preferredLanguages,
    required_languages: ml.requiredLanguages,
    required_platforms: ml.requiredPlatforms,
    deliverables,
    budget: {
      amount: ml.budgetAmount.toFixed(2),
      currency: ml.budgetCurrency,
      normalized_usd: ml.budgetNormalizedUsd.toFixed(2),
      rate_version: ml.budgetRateVersion,
      purpose: ml.budgetPurpose,
    },
    target_audience: {
      description: ml.targetAudienceDescription ?? '',
      interests: ml.targetAudienceInterests,
      markets: ml.targetAudienceMarkets,
    },
    usage_rights: usageRights,
  };
}

export function mapEvidenceToMl(creatorId: string, rows: CredibilityEvent[]) {
  return rows.map((row) => ({
    id: row.sourceEventId,
    journey_id: row.sourceJourneyId,
    creator_id: creatorId,
    opportunity_id: row.opportunityMlProfile.opportunityId,
    contract_id: row.sourceContractId,
    event_type: eventTypeSchema.parse(row.eventType),
    occurred_at: row.occurredAt.toISOString().slice(0, 10),
    previous_event_id: row.previousSourceEventId,
    details: jsonObject(row.details, 'credibility event details'),
  }));
}
