import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DemoDataset, RecordJson } from '../demo-import/core.js';
import { recordHash } from '../demo-import/core.js';

export const CONSOLIDATION_NAMESPACE = 'africre8-unified-v1';
export const CONSOLIDATION_VERSION = '1.0';

export type ConsolidationScope = {
  version: '1.0';
  namespace: typeof CONSOLIDATION_NAMESPACE;
  syntheticCreatorIds: string[];
  syntheticBrandIds: string[];
  syntheticOpportunityIds: string[];
  syntheticEvidenceCreatorIds: string[];
  creatorIdentityMappings: Record<string, string>;
  brandIdentityMappings: Record<string, string>;
  opportunityIdentityMappings: Record<string, string>;
};

const assert = (condition: unknown, message: string): asserts condition => {
  if (!condition) throw new Error(message);
};

const uniqueStrings = (value: unknown, label: string) => {
  assert(Array.isArray(value), `${label} must be an array`);
  assert(
    value.every((item) => typeof item === 'string' && item.length > 0),
    `${label} must contain nonempty IDs`,
  );
  assert(
    new Set(value).size === value.length,
    `${label} contains duplicate IDs`,
  );
  return value as string[];
};

const stringMap = (value: unknown, label: string) => {
  assert(
    value && typeof value === 'object' && !Array.isArray(value),
    `${label} must be an object`,
  );
  for (const [source, target] of Object.entries(
    value as Record<string, unknown>,
  ))
    assert(
      source.length > 0 && typeof target === 'string' && target.length > 0,
      `${label} has an invalid mapping`,
    );
  return value as Record<string, string>;
};

export function loadConsolidationScope(path: string): ConsolidationScope {
  const raw = JSON.parse(readFileSync(resolve(path), 'utf8')) as Record<
    string,
    unknown
  >;
  assert(
    raw.version === CONSOLIDATION_VERSION,
    `scope version must be ${CONSOLIDATION_VERSION}`,
  );
  assert(
    raw.namespace === CONSOLIDATION_NAMESPACE,
    `scope namespace must be ${CONSOLIDATION_NAMESPACE}`,
  );
  const scope: ConsolidationScope = {
    version: '1.0',
    namespace: CONSOLIDATION_NAMESPACE,
    syntheticCreatorIds: uniqueStrings(
      raw.syntheticCreatorIds,
      'syntheticCreatorIds',
    ),
    syntheticBrandIds: uniqueStrings(
      raw.syntheticBrandIds,
      'syntheticBrandIds',
    ),
    syntheticOpportunityIds: uniqueStrings(
      raw.syntheticOpportunityIds,
      'syntheticOpportunityIds',
    ),
    syntheticEvidenceCreatorIds: uniqueStrings(
      raw.syntheticEvidenceCreatorIds,
      'syntheticEvidenceCreatorIds',
    ),
    creatorIdentityMappings: stringMap(
      raw.creatorIdentityMappings,
      'creatorIdentityMappings',
    ),
    brandIdentityMappings: stringMap(
      raw.brandIdentityMappings,
      'brandIdentityMappings',
    ),
    opportunityIdentityMappings: stringMap(
      raw.opportunityIdentityMappings,
      'opportunityIdentityMappings',
    ),
  };
  for (const id of Object.keys(scope.creatorIdentityMappings))
    assert(
      !scope.syntheticCreatorIds.includes(id),
      `creator ${id} cannot be both mapped and newly synthetic`,
    );
  for (const id of Object.keys(scope.brandIdentityMappings))
    assert(
      !scope.syntheticBrandIds.includes(id),
      `brand ${id} cannot be both mapped and newly synthetic`,
    );
  for (const id of Object.keys(scope.opportunityIdentityMappings))
    assert(
      !scope.syntheticOpportunityIds.includes(id),
      `opportunity ${id} cannot be both mapped and newly synthetic`,
    );
  for (const id of scope.syntheticEvidenceCreatorIds)
    assert(
      scope.syntheticCreatorIds.includes(id),
      `evidence creator ${id} must be an explicitly new synthetic identity`,
    );
  return scope;
}

export function validateScopeAgainstDataset(
  scope: ConsolidationScope,
  dataset: DemoDataset,
) {
  const creators = new Set(dataset.creators.map((row) => row.id));
  const brands = new Set(dataset.brands.map((row) => row.id));
  const opportunities = new Set(dataset.opportunities.map((row) => row.id));
  for (const id of [
    ...scope.syntheticCreatorIds,
    ...Object.keys(scope.creatorIdentityMappings),
  ])
    assert(
      creators.has(id),
      `scope references unknown synthetic creator ${id}`,
    );
  for (const id of [
    ...scope.syntheticBrandIds,
    ...Object.keys(scope.brandIdentityMappings),
  ])
    assert(brands.has(id), `scope references unknown synthetic brand ${id}`);
  for (const id of [
    ...scope.syntheticOpportunityIds,
    ...Object.keys(scope.opportunityIdentityMappings),
  ])
    assert(
      opportunities.has(id),
      `scope references unknown synthetic opportunity ${id}`,
    );
  const approvedBrands = new Set([
    ...scope.syntheticBrandIds,
    ...Object.keys(scope.brandIdentityMappings),
  ]);
  for (const id of scope.syntheticOpportunityIds) {
    const opportunity = dataset.opportunities.find((row) => row.id === id)!;
    assert(
      approvedBrands.has(opportunity.brand_id),
      `synthetic opportunity ${id} requires an approved or mapped brand ${opportunity.brand_id}`,
    );
  }
  const approvedOpportunities = new Set([
    ...scope.syntheticOpportunityIds,
    ...Object.keys(scope.opportunityIdentityMappings),
  ]);
  for (const creatorId of scope.syntheticEvidenceCreatorIds) {
    const required = new Set(
      dataset.interactions
        .filter((row) => row.creator_id === creatorId)
        .map((row) => row.opportunity_id),
    );
    for (const opportunityId of required)
      assert(
        approvedOpportunities.has(opportunityId),
        `evidence for ${creatorId} requires approved opportunity ${opportunityId}`,
      );
  }
}

export const productionFingerprint = (snapshot: unknown) =>
  recordHash(snapshot);
export const consolidationPlanHash = (input: unknown) => recordHash(input);

export function consolidationDatabaseIdentity(databaseUrl: string) {
  const url = new URL(databaseUrl);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const canonicalTarget = `${url.protocol}//${url.hostname.toLowerCase()}:${url.port || '5432'}/${database}`;
  return {
    host: url.hostname.toLowerCase(),
    database,
    fingerprint: recordHash(canonicalTarget),
  };
}

export function assertApprovedConsolidationTarget(input: {
  databaseUrl?: string;
  targetLabel?: string;
  confirmedTargetLabel?: string;
  expectedTargetFingerprint?: string;
  confirmedTargetFingerprint?: string;
  confirmedProductionFingerprint?: string;
  actualProductionFingerprint: string;
  confirmedPlanHash?: string;
  actualPlanHash: string;
  enabled?: string;
  confirmation?: string;
  backupConfirmed?: string;
  backupReference?: string;
  confirmedBackupReference?: string;
  write: boolean;
}) {
  assert(input.databaseUrl, 'DATABASE_URL is required');
  const identity = consolidationDatabaseIdentity(input.databaseUrl);
  const { database, fingerprint } = identity;
  assert(
    input.targetLabel && input.targetLabel.length >= 3,
    'CONSOLIDATION_TARGET_LABEL is required',
  );
  assert(
    input.targetLabel === input.confirmedTargetLabel,
    'target label confirmation is missing or incorrect',
  );
  assert(
    input.expectedTargetFingerprint === fingerprint,
    'CONSOLIDATION_TARGET_FINGERPRINT does not match DATABASE_URL',
  );
  assert(
    input.confirmedTargetFingerprint === fingerprint,
    'CLI target fingerprint confirmation is missing or incorrect',
  );
  if (input.write) {
    assert(
      input.enabled === 'true',
      'CONSOLIDATION_ENABLED=true is required for writes',
    );
    assert(
      input.confirmation === 'APPLY_REVIEWED_CONSOLIDATION',
      'consolidation confirmation is missing or incorrect',
    );
    assert(
      input.confirmedProductionFingerprint ===
        input.actualProductionFingerprint,
      'production snapshot fingerprint changed or was not confirmed',
    );
    assert(
      input.confirmedPlanHash === input.actualPlanHash,
      'reviewed consolidation plan hash changed or was not confirmed',
    );
    assert(
      input.backupConfirmed === 'true',
      'CONSOLIDATION_BACKUP_CONFIRMED=true is required for writes',
    );
    assert(
      input.backupReference && input.backupReference.length >= 8,
      'CONSOLIDATION_BACKUP_REFERENCE is required for writes',
    );
    assert(
      input.backupReference === input.confirmedBackupReference,
      'backup reference confirmation is missing or incorrect',
    );
  }
  return { host: identity.host, database, fingerprint };
}

export function mapSyntheticCreator(
  source: RecordJson,
  identitySynthetic: boolean,
) {
  return {
    scalar: {
      namespace: CONSOLIDATION_NAMESPACE,
      sourceCreatorId: source.id,
      sourceRecordHash: recordHash(source),
      schemaVersion: CONSOLIDATION_VERSION,
      synthetic: identitySynthetic,
      sourceKind: identitySynthetic
        ? 'approved-synthetic-identity'
        : 'production-identity-synthetic-features',
      portfolioDescription: source.portfolio_description,
      contentTone: source.content_tone,
      contentLanguages: source.content_languages,
      audienceInterests: source.audience_interests,
      creativeStyles: source.creative_styles,
      productionCapabilities: source.production_capabilities,
      typicalLeadTimeDays: source.typical_lead_time_days,
      imageAssetId: source.image_asset_id,
      sourceAvailability: source.availability,
      commercialExperience: source.commercial_experience,
      featureProvenance: {
        identity: identitySynthetic ? 'synthetic' : 'production',
        recommendation_features: 'africre8-demo-v2',
      },
      dataQuality: {
        synthetic_features: true,
        private_evaluation_features_used: false,
      },
    },
    markets: source.audience.markets.map((item: RecordJson) => ({
      countryCode: item.country_code,
      sharePercent: item.share_percent,
    })),
    capabilities: source.deliverable_capabilities.map((item: RecordJson) => ({
      platform: item.platform,
      format: item.format,
    })),
    rates: source.commercial_rates.map((item: RecordJson) => ({
      platform: item.platform,
      format: item.format,
      amount: item.base_rate.amount,
      currency: item.base_rate.currency,
      normalizedUsd: item.base_rate.normalized_usd,
      rateVersion: item.base_rate.rate_version,
      purpose: item.base_rate.purpose,
      includes: item.includes,
      usageRightsMultipliers: item.usage_rights_multiplier,
      categoryExclusivity30DaysMultiplier:
        item.category_exclusivity_30_days_multiplier,
    })),
  };
}

export function mapSyntheticOpportunity(
  source: RecordJson,
  identitySynthetic: boolean,
) {
  return {
    namespace: CONSOLIDATION_NAMESPACE,
    sourceOpportunityId: source.id,
    sourceRecordHash: recordHash(source),
    sourceBrandId: source.brand_id,
    schemaVersion: CONSOLIDATION_VERSION,
    synthetic: identitySynthetic,
    industry: source.industry,
    product: source.product,
    objective: source.objective,
    tone: source.tone,
    creativeConcept: source.creative_concept,
    crossCategoryRationale: source.cross_category_rationale,
    callToAction: source.call_to_action,
    budgetAmount: source.budget.amount,
    budgetCurrency: source.budget.currency,
    budgetNormalizedUsd: source.budget.normalized_usd,
    budgetRateVersion: source.budget.rate_version,
    budgetPurpose: source.budget.purpose,
    budgetScope: source.budget_scope,
    compatibleNiches: source.compatible_niches,
    preferredLanguages: source.preferred_languages,
    preferredPlatforms: source.preferred_platforms,
    requiredLanguages: source.required_languages,
    requiredPlatforms: source.required_platforms,
    keyMessages: source.key_messages,
    successMetrics: source.success_metrics,
    targetAudienceDescription: source.target_audience.description,
    targetAudienceInterests: source.target_audience.interests,
    targetAudienceMarkets: source.target_audience.markets,
    deliverables: source.deliverables,
    usageRights: source.usage_rights,
    timeline: source.timeline,
    brandSnapshot: source.brand_snapshot,
    heldOut: source.held_out,
    featureProvenance: {
      identity: identitySynthetic ? 'synthetic' : 'production',
      recommendation_features: 'africre8-demo-v2',
    },
    dataQuality: {
      synthetic_features: true,
      private_evaluation_features_used: false,
    },
  };
}
