import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { MlService } from '../src/ml/ml.service.js';

const decimal = (value: string) => ({
  toFixed: () => value,
  toString: () => value,
});
const creator = {
  id: 'ml-creator',
  creatorId: 'creator-1',
  namespace: 'africre8-demo-v2',
  sourceCreatorId: 'c-1',
  portfolioDescription: 'Food films',
  contentTone: 'warm',
  contentLanguages: ['en'],
  audienceInterests: ['food'],
  creativeStyles: ['documentary'],
  productionCapabilities: ['video'],
  creator: {
    userId: 'creator-1',
    displayName: 'Ada',
    avatarUrl: null,
    bio: 'Chef',
    location: 'Lagos',
    category: 'Food',
    niches: ['food'],
    availability: 'available',
    user: { status: 'ACTIVE', onboardedAt: new Date(), openToInvites: true },
    socials: [{ platform: 'instagram' }],
  },
  audienceMarkets: [{ countryCode: 'NG', sharePercent: decimal('80') }],
  deliverableCapabilities: [{ platform: 'instagram', format: 'reel' }],
  commercialRates: [
    {
      platform: 'instagram',
      format: 'reel',
      amount: decimal('100'),
      normalizedUsd: decimal('100'),
      currency: 'USD',
      rateVersion: 'demo',
      purpose: 'demo',
      usageRightsMultipliers: {},
      categoryExclusivity30DaysMultiplier: decimal('1'),
      includes: [],
    },
  ],
};
const opportunity = {
  id: 'opportunity-1',
  brandId: 'brand-1',
  title: 'Launch',
  brief: 'Create a food launch film',
  category: 'Food',
  status: 'PUBLISHED',
  mlProfile: {
    namespace: 'africre8-demo-v2',
    industry: 'Food',
    product: 'Snack',
    objective: 'Awareness',
    tone: 'warm',
    creativeConcept: 'Taste',
    keyMessages: ['taste'],
    compatibleNiches: ['food'],
    preferredLanguages: ['en'],
    requiredLanguages: ['en'],
    requiredPlatforms: ['instagram'],
    deliverables: [{ platform: 'instagram', format: 'reel', quantity: 1 }],
    budgetAmount: decimal('500'),
    budgetCurrency: 'USD',
    budgetNormalizedUsd: decimal('500'),
    budgetRateVersion: 'demo',
    budgetPurpose: 'demo',
    targetAudienceDescription: 'Food lovers',
    targetAudienceInterests: ['food'],
    targetAudienceMarkets: ['NG'],
    usageRights: { paid_usage: false, category_exclusivity_days: 0 },
  },
};
const response = {
  campaign_id: 'opportunity-1',
  ranker: 'structured',
  model_version: 'v1',
  candidate_count: 1,
  eligible_count: 1,
  excluded_count: 0,
  recommendations: [
    {
      rank: 1,
      creator_id: 'creator-1',
      score: 0.73,
      eligible: true,
      estimated_fee_usd: '100.00',
      explanation: { summary: 'Strong fit', top_signals: [], components: {} },
    },
  ],
  exclusions: [],
  latency_ms: 2,
  warnings: [],
};

describe('MlService', () => {
  it('keeps organic scores unchanged and sponsored placements separate', async () => {
    const prisma = {
      opportunity: { findUnique: vi.fn().mockResolvedValue(opportunity) },
      creatorMlProfile: { findMany: vi.fn().mockResolvedValue([creator]) },
    } as any;
    const client = { recommend: vi.fn().mockResolvedValue(response) } as any;
    const result = await new MlService(prisma, client).recommend(
      'brand-1',
      'opportunity-1',
      {
        mode: 'structured',
        limit: 20,
        includeExcluded: false,
        includeCredibility: false,
      },
    );
    expect(result.organic[0].score).toBe(0.73);
    expect(result.sponsored).toEqual([]);
    expect(result.organic[0].creator).not.toHaveProperty('credibilityScore');
    expect(result.organic[0].creator).not.toHaveProperty('followers');
  });

  it('does not reveal another brand campaign', async () => {
    const prisma = {
      opportunity: { findUnique: vi.fn().mockResolvedValue(opportunity) },
    } as any;
    await expect(
      new MlService(prisma, {} as any).recommend(
        'other-brand',
        'opportunity-1',
        {
          mode: 'structured',
          limit: 20,
          includeExcluded: false,
          includeCredibility: false,
        },
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('passes only isolated demo evidence to credibility scoring', async () => {
    const profile = {
      userId: 'creator-1',
      user: { status: 'ACTIVE', onboardedAt: new Date(), openToInvites: true },
      mlProfile: { id: 'ml-creator' },
    };
    const event = {
      sourceEventId: 'event-1',
      sourceJourneyId: 'journey-1',
      sourceContractId: 'contract-1',
      previousSourceEventId: null,
      eventType: 'contract',
      occurredAt: new Date('2026-01-01'),
      details: {},
      opportunityMlProfile: { opportunityId: 'opportunity-1' },
    };
    const prisma = {
      creatorProfile: { findUnique: vi.fn().mockResolvedValue(profile) },
      demoMlEvidenceEvent: { findMany: vi.fn().mockResolvedValue([event]) },
    } as any;
    const client = {
      credibility: vi
        .fn()
        .mockResolvedValue({
          creator_id: 'creator-1',
          status: 'scored',
          credibility_score: 70,
          evidence_tier: 'limited',
          model_version: 'v1',
        }),
    } as any;
    await new MlService(prisma, client).credibility(
      { id: 'brand-1', role: 'BRAND' },
      'creator-1',
    );
    expect(client.credibility).toHaveBeenCalledWith(
      expect.objectContaining({
        creator_id: 'creator-1',
        events: [
          expect.objectContaining({ id: 'event-1', creator_id: 'creator-1' }),
        ],
      }),
      undefined,
    );
  });
});
