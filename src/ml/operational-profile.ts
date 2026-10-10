// Operational records (the app's own creators and briefs) mapped to ML profiles. Shared by the live sync
// (src/ml/ml-sync.service.ts) and the batch enrichment script (prisma/enrich-existing-ml.ts).
import { createHash } from 'node:crypto';

export const OPERATIONAL_ML_NAMESPACE = 'africre8-operational-v1';
export const OPERATIONAL_SCHEMA_VERSION = '1.0';
export const OPERATIONAL_RATE_VERSION = 'operational-ngn-reference-v1';
export const NGN_PER_USD = 1500;

type JsonRecord = Record<string, any>;

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

export const operationalRecordHash = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');

export function platformFromDeliverable(value: string) {
  const text = value.toLowerCase();
  if (/\b(instagram|ig)\b/.test(text)) return 'instagram' as const;
  if (/\b(tik[ -]?tok)\b/.test(text)) return 'tiktok' as const;
  if (/\byoutube\b/.test(text)) return 'youtube' as const;
  if (/\b(twitter|x post|x thread)\b/.test(text)) return 'x' as const;
  if (/\b(facebook|fb)\b/.test(text)) return 'facebook' as const;
  return null;
}

export const operationalFormat = (platform: string) => `${platform}_content`;

export function mapOperationalCreator(row: JsonRecord) {
  const platforms = [
    ...new Set<string>(row.socials.map((social: JsonRecord) => social.platform)),
  ].sort();
  const priceKobo = Number(row.priceFromKobo);
  const hasRate = Number.isSafeInteger(priceKobo) && priceKobo > 0;
  const source = {
    creatorId: row.userId,
    displayName: row.displayName,
    bio: row.bio,
    category: row.category,
    niches: [...row.niches].sort(),
    portfolio: row.portfolio,
    priceFromKobo: row.priceFromKobo,
    availability: row.availability,
    platforms,
  };
  return {
    sourceHash: operationalRecordHash(source),
    scalar: {
      namespace: OPERATIONAL_ML_NAMESPACE,
      sourceCreatorId: row.userId,
      sourceRecordHash: operationalRecordHash(source),
      schemaVersion: OPERATIONAL_SCHEMA_VERSION,
      synthetic: false,
      sourceKind: 'operational-profile',
      portfolioDescription: row.bio || null,
      contentTone: null,
      contentLanguages: [],
      audienceInterests: row.niches,
      creativeStyles: [],
      productionCapabilities: [],
      typicalLeadTimeDays: null,
      imageAssetId: null,
      sourceAvailability: row.availability,
      commercialExperience: null,
      featureProvenance: {
        identity: 'operational',
        biography: 'operational',
        niches: 'operational',
        platforms: 'operational_social_accounts',
        commercial_rates: 'operational_starting_price',
      },
      dataQuality: {
        missing: [
          'content_languages',
          'audience_geography',
          'creative_styles',
          'production_capabilities',
        ],
        defaults: ['generic_platform_content_format'],
      },
    },
    capabilities: platforms.map((platform) => ({
      platform,
      format: operationalFormat(platform),
    })),
    rates: hasRate
      ? platforms.map((platform) => ({
          platform,
          format: operationalFormat(platform),
          amount: (priceKobo / 100).toFixed(2),
          currency: 'NGN',
          normalizedUsd: (priceKobo / 100 / NGN_PER_USD).toFixed(2),
          rateVersion: OPERATIONAL_RATE_VERSION,
          purpose: 'Operational starting rate; confirm scope with creator',
          includes: ['one platform content deliverable'],
          usageRightsMultipliers: { organic_only: '1' },
          categoryExclusivity30DaysMultiplier: '1',
        }))
      : [],
    warnings: [
      ...(platforms.length ? [] : ['no_social_platforms']),
      ...(hasRate ? [] : ['no_commercial_rate']),
      'content_languages_not_collected',
      'audience_geography_not_collected',
    ],
  };
}

export function mapOperationalOpportunity(row: JsonRecord) {
  const parsed = row.deliverables.map((text: string) => ({
    text,
    platform: platformFromDeliverable(text),
  }));
  const unknown = parsed
    .filter((item: JsonRecord) => !item.platform)
    .map((item: JsonRecord) => item.text);
  if (unknown.length) {
    return {
      conflict: `deliverable platform is not explicit: ${unknown.join(' | ')}`,
    } as const;
  }
  const platforms = [
    ...new Set<string>(parsed.map((item: JsonRecord) => item.platform)),
  ].sort();
  const deliverables = parsed.map((item: JsonRecord) => ({
    platform: item.platform,
    format: operationalFormat(item.platform),
    quantity: 1,
  }));
  const source = {
    opportunityId: row.id,
    brandId: row.brandId,
    title: row.title,
    brief: row.brief,
    category: row.category,
    budgetKobo: row.budgetKobo,
    deadlineDays: row.deadlineDays,
    deliverables: row.deliverables,
    brandIndustry: row.brandIndustry,
  };
  const budgetNgn = Number(row.budgetKobo) / 100;
  return {
    sourceHash: operationalRecordHash(source),
    scalar: {
      namespace: OPERATIONAL_ML_NAMESPACE,
      sourceOpportunityId: row.id,
      sourceRecordHash: operationalRecordHash(source),
      sourceBrandId: row.brandId,
      schemaVersion: OPERATIONAL_SCHEMA_VERSION,
      synthetic: false,
      industry: row.brandIndustry || null,
      product: null,
      objective: null,
      tone: null,
      creativeConcept: null,
      crossCategoryRationale: null,
      callToAction: null,
      budgetAmount: budgetNgn.toFixed(2),
      budgetCurrency: 'NGN',
      budgetNormalizedUsd: (budgetNgn / NGN_PER_USD).toFixed(2),
      budgetRateVersion: OPERATIONAL_RATE_VERSION,
      budgetPurpose: 'Operational opportunity budget',
      budgetScope: 'Total budget for listed operational deliverables',
      compatibleNiches: row.category ? [row.category] : [],
      preferredLanguages: [],
      preferredPlatforms: [],
      requiredLanguages: [],
      requiredPlatforms: platforms,
      keyMessages: [],
      successMetrics: [],
      targetAudienceDescription: null,
      targetAudienceInterests: [],
      targetAudienceMarkets: [],
      deliverables,
      usageRights: { paid_usage: false, category_exclusivity_days: 0 },
      timeline: { deadline_days: row.deadlineDays },
      brandSnapshot: row.brandIndustry ? { industry: row.brandIndustry } : null,
      heldOut: false,
      featureProvenance: {
        identity: 'operational',
        brief: 'operational',
        budget: 'operational',
        deliverables: 'parsed_operational_text',
        brand_industry: row.brandIndustry ? 'operational' : 'missing',
      },
      dataQuality: {
        missing: [
          'languages',
          'target_audience',
          'campaign_objective',
        ],
        defaults: [
          'organic_usage_only',
          'no_category_exclusivity',
          'provisional_ngn_usd_rate',
        ],
      },
    },
    warnings: [
      'languages_not_collected',
      'usage_rights_defaulted_to_organic_only',
    ],
  };
}
