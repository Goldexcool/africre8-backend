import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient, type Platform, type Prisma } from '../src/generated/prisma/client.js';
import {
  EXPECTED_NAMESPACE,
  IMPORTER_VERSION,
  assertApprovedDemoTarget,
  legacyCreatorEmail,
  loadAndValidateDataset,
  parseReviewedMapping,
  recordHash,
  summarize,
  syntheticEmail,
  unusablePasswordHash,
} from './demo-import/core.js';

type Counts = { created: number; updated: number; unchanged: number; skipped: number; conflicts: number };
type Report = {
  mode: 'offline-validation' | 'dry-run' | 'write';
  namespace: string;
  databaseFingerprint?: string;
  dataset: ReturnType<typeof summarize>;
  creators: Counts;
  brands: Counts;
  opportunities: Counts;
  evidenceEvents: Counts;
  conflictDetails: string[];
  operationalSideEffects: { campaigns: 0; submissions: 0; verifications: 0; disputes: 0; transactions: 0; auditLogs: 0; payouts: 0 };
};

const empty = (): Counts => ({ created: 0, updated: 0, unchanged: 0, skipped: 0, conflicts: 0 });
const arg = (name: string) => process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
const write = process.argv.includes('--write');
const offline = process.argv.includes('--offline-validate');
const dataRoot = resolve(arg('--data') ?? 'services/ml/data/demo-v2');
const dataset = loadAndValidateDataset(dataRoot);
const fixture = JSON.parse(readFileSync(resolve('prisma/seed-data/creators.json'), 'utf8')) as { id: string; name: string }[];
const fixtureIndex = new Map(fixture.map((row, index) => [row.id, { ...row, index }]));
const reviewed = parseReviewedMapping(arg('--reviewed-mapping'));

const report: Report = {
  mode: offline ? 'offline-validation' : write ? 'write' : 'dry-run',
  namespace: EXPECTED_NAMESPACE,
  dataset: summarize(dataset),
  creators: empty(), brands: empty(), opportunities: empty(), evidenceEvents: empty(),
  conflictDetails: [],
  operationalSideEffects: { campaigns: 0, submissions: 0, verifications: 0, disputes: 0, transactions: 0, auditLogs: 0, payouts: 0 },
};

if (offline) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const target = assertApprovedDemoTarget({
  databaseUrl: process.env.DATABASE_URL,
  databaseEnvironment: process.env.DEMO_DATABASE_ENV,
  expectedFingerprint: process.env.DEMO_DATABASE_FINGERPRINT,
  confirmedFingerprint: arg('--confirm-fingerprint'),
  importEnabled: process.env.DEMO_DATA_IMPORT_ENABLED,
  nodeEnvironment: process.env.NODE_ENV,
  railwayReplacementApproved: process.env.DEMO_RAILWAY_REPLACEMENT_APPROVED,
  replacementConfirmation: arg('--confirm-replacement'),
  write,
});
report.databaseFingerprint = target.fingerprint;

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
const userByEmail = new Map<string, any>();

function conflict(section: Counts, message: string) {
  section.conflicts++;
  section.skipped++;
  report.conflictDetails.push(message);
}

function moneyToKobo(row: Record<string, any>) {
  return Math.round(Number(row.normalized_usd) * 1500 * 100);
}

async function inspect() {
  const previous = await prisma.demoDatasetImport.findUnique({
    where: { namespace_manifestSha256_databaseFingerprint: { namespace: EXPECTED_NAMESPACE, manifestSha256: dataset.manifestSha256, databaseFingerprint: target.fingerprint } },
  });
  if (previous?.status === 'completed') {
    report.creators.unchanged = dataset.creators.length;
    report.brands.unchanged = dataset.brands.length;
    report.opportunities.unchanged = dataset.opportunities.length;
    report.evidenceEvents.unchanged = dataset.interactions.length;
    return { alreadyImported: true, creatorPlan: [], brandPlan: [], opportunityPlan: [], eventPlan: [] };
  }

  const [mlCreators, mlOpportunities, mlEvents] = await Promise.all([
    prisma.creatorMlProfile.findMany({ where: { namespace: EXPECTED_NAMESPACE }, include: { creator: { include: { user: true } } } }),
    prisma.opportunityMlProfile.findMany({ where: { namespace: EXPECTED_NAMESPACE }, include: { opportunity: true } }),
    prisma.demoMlEvidenceEvent.findMany({ where: { namespace: EXPECTED_NAMESPACE }, select: { sourceEventId: true, sourceRecordHash: true } }),
  ]);
  const creatorBySource = new Map(mlCreators.map((row) => [row.sourceCreatorId, row]));
  const opportunityBySource = new Map(mlOpportunities.map((row) => [row.sourceOpportunityId, row]));
  const eventBySource = new Map(mlEvents.map((row) => [row.sourceEventId, row]));
  const candidateEmails = new Set<string>();
  for (const row of dataset.creators) {
    candidateEmails.add(syntheticEmail('creator', row.id));
    const legacy = fixtureIndex.get(row.id);
    if (legacy) candidateEmails.add(legacyCreatorEmail(legacy.index, legacy.name));
    if (reviewed.creators[row.id]) candidateEmails.add(reviewed.creators[row.id]);
  }
  for (const row of dataset.brands) candidateEmails.add(syntheticEmail('brand', row.id));
  for (const row of await prisma.user.findMany({ where: { email: { in: [...candidateEmails] } }, include: { creatorProfile: true, brandProfile: true } })) userByEmail.set(row.email, row);

  const creatorPlan: { source: Record<string, any>; action: 'create' | 'adopt' | 'update' | 'unchanged'; userId?: string; email: string }[] = [];
  for (const source of dataset.creators) {
    const hash = recordHash(source);
    const mapped = creatorBySource.get(source.id);
    if (mapped) {
      if (!mapped.synthetic || mapped.creator.user.role !== 'CREATOR') conflict(report.creators, `creator ${source.id}: existing mapping is not a synthetic creator`);
      else if (mapped.sourceRecordHash === hash) { report.creators.unchanged++; creatorPlan.push({ source, action: 'unchanged', userId: mapped.creatorId, email: mapped.creator.user.email }); }
      else { report.creators.updated++; creatorPlan.push({ source, action: 'update', userId: mapped.creatorId, email: mapped.creator.user.email }); }
      continue;
    }
    const legacy = fixtureIndex.get(source.id);
    const legacyEmail = legacy ? legacyCreatorEmail(legacy.index, legacy.name) : undefined;
    const approvedEmail = reviewed.creators[source.id];
    const existingLegacy = legacyEmail ? userByEmail.get(legacyEmail) : undefined;
    if (existingLegacy) {
      if (approvedEmail !== legacyEmail || existingLegacy.role !== 'CREATOR' || existingLegacy.creatorProfile?.displayName !== source.display_name) {
        conflict(report.creators, `creator ${source.id}: legacy account ${legacyEmail} requires an explicit reviewed mapping`);
      } else {
        report.creators.updated++;
        creatorPlan.push({ source, action: 'adopt', userId: existingLegacy.id, email: legacyEmail! });
      }
      continue;
    }
    if (approvedEmail) {
      const approved = userByEmail.get(approvedEmail);
      if (!approved || approved.role !== 'CREATOR' || approved.creatorProfile?.displayName !== source.display_name) conflict(report.creators, `creator ${source.id}: reviewed mapping does not identify a matching creator`);
      else { report.creators.updated++; creatorPlan.push({ source, action: 'adopt', userId: approved.id, email: approvedEmail }); }
      continue;
    }
    const email = syntheticEmail('creator', source.id);
    if (userByEmail.has(email)) conflict(report.creators, `creator ${source.id}: unmanaged synthetic email collision`);
    else { report.creators.created++; creatorPlan.push({ source, action: 'create', email }); }
  }

  const brandPlan: { source: Record<string, any>; action: 'create' | 'unchanged'; userId?: string; email: string }[] = [];
  for (const source of dataset.brands) {
    const email = syntheticEmail('brand', source.id);
    const existing = userByEmail.get(email);
    if (!existing) { report.brands.created++; brandPlan.push({ source, action: 'create', email }); }
    else if (existing.role === 'BRAND' && existing.brandProfile) { report.brands.unchanged++; brandPlan.push({ source, action: 'unchanged', userId: existing.id, email }); }
    else conflict(report.brands, `brand ${source.id}: unmanaged email collision`);
  }

  const opportunityPlan = dataset.opportunities.map((source) => {
    const mapped = opportunityBySource.get(source.id);
    const hash = recordHash(source);
    if (!mapped) report.opportunities.created++;
    else if (mapped.sourceRecordHash === hash) report.opportunities.unchanged++;
    else report.opportunities.updated++;
    return { source, mapped, hash };
  });
  const eventPlan = dataset.interactions.map((source) => {
    const mapped = eventBySource.get(source.id);
    const hash = recordHash(source);
    if (!mapped) report.evidenceEvents.created++;
    else if (mapped.sourceRecordHash === hash) report.evidenceEvents.unchanged++;
    else report.evidenceEvents.updated++;
    return { source, mapped, hash };
  });
  return { alreadyImported: false, creatorPlan, brandPlan, opportunityPlan, eventPlan };
}

async function execute(plan: Awaited<ReturnType<typeof inspect>>) {
  if (!write || plan.alreadyImported) return;
  if (report.conflictDetails.length) throw new Error(`write refused: ${report.conflictDetails.length} identity conflict(s)`);
  const startedAt = new Date();
  await prisma.$transaction(async (tx) => {
    const brandIds = new Map<string, string>();
    for (const item of plan.brandPlan) {
      let userId = item.userId;
      if (item.action === 'create') {
        const user = await tx.user.create({ data: { email: item.email, passwordHash: unusablePasswordHash(), role: 'BRAND', status: 'ACTIVE', verificationStatus: 'VERIFIED', onboardedAt: startedAt, emailVerifiedAt: startedAt } });
        userId = user.id;
        await tx.brandProfile.create({ data: { userId, businessName: item.source.name, industry: item.source.industry, location: `${item.source.headquarters.city}, ${item.source.headquarters.country_code}`, about: `${item.source.positioning}. ${item.source.disclaimer}` } });
      }
      brandIds.set(item.source.id, userId!);
    }

    const creatorMlIds = new Map<string, string>();
    for (const item of plan.creatorPlan) {
      const source = item.source;
      let creatorId = item.userId;
      if (item.action === 'create') {
        const user = await tx.user.create({ data: { email: item.email, passwordHash: unusablePasswordHash(), role: 'CREATOR', status: 'ACTIVE', verificationStatus: 'VERIFIED', onboardedAt: startedAt, emailVerifiedAt: startedAt, openToInvites: source.availability !== 'booked' } });
        creatorId = user.id;
        const normalized = source.commercial_rates.map((rate: Record<string, any>) => Number(rate.base_rate.normalized_usd));
        await tx.creatorProfile.create({ data: { userId: creatorId, displayName: source.display_name, bio: source.bio, location: `${source.residence.city}, ${source.residence.country}`, category: source.category, niches: source.niches, portfolio: [], priceFromKobo: Math.round(Math.min(...normalized) * 1500 * 100), priceToKobo: Math.round(Math.max(...normalized) * 1500 * 100), availability: source.availability === 'limited' ? 'busy' : source.availability, credibilityScore: 0, ratingAvg: 0, completedCampaigns: 0 } });
        await tx.socialAccount.createMany({ data: source.socials.map((social: Record<string, any>) => ({ creatorId, platform: social.platform as Platform, handle: social.handle, followers: social.followers, engagementRate: social.engagement_rate_percent })) });
      }
      const ml = await tx.creatorMlProfile.upsert({
        where: { namespace_sourceCreatorId: { namespace: EXPECTED_NAMESPACE, sourceCreatorId: source.id } },
        create: { creatorId: creatorId!, namespace: EXPECTED_NAMESPACE, sourceCreatorId: source.id, sourceRecordHash: recordHash(source), schemaVersion: dataset.manifest.schema_version, synthetic: true, sourceKind: source.source.kind, portfolioDescription: source.portfolio_description, contentTone: source.content_tone, contentLanguages: source.content_languages, audienceInterests: source.audience_interests, creativeStyles: source.creative_styles, productionCapabilities: source.production_capabilities, typicalLeadTimeDays: source.typical_lead_time_days, imageAssetId: source.image_asset_id, sourceAvailability: source.availability, commercialExperience: source.commercial_experience },
        update: { sourceRecordHash: recordHash(source), schemaVersion: dataset.manifest.schema_version, sourceKind: source.source.kind, portfolioDescription: source.portfolio_description, contentTone: source.content_tone, contentLanguages: source.content_languages, audienceInterests: source.audience_interests, creativeStyles: source.creative_styles, productionCapabilities: source.production_capabilities, typicalLeadTimeDays: source.typical_lead_time_days, imageAssetId: source.image_asset_id, sourceAvailability: source.availability, commercialExperience: source.commercial_experience },
      });
      creatorMlIds.set(source.id, ml.id);
      if (item.action !== 'unchanged') {
        await tx.creatorAudienceMarket.deleteMany({ where: { creatorMlProfileId: ml.id } });
        await tx.creatorDeliverableCapability.deleteMany({ where: { creatorMlProfileId: ml.id } });
        await tx.creatorCommercialRate.deleteMany({ where: { creatorMlProfileId: ml.id } });
        await tx.creatorAudienceMarket.createMany({ data: source.audience.markets.map((market: Record<string, any>) => ({ creatorMlProfileId: ml.id, countryCode: market.country_code, sharePercent: market.share_percent })) });
        await tx.creatorDeliverableCapability.createMany({ data: source.deliverable_capabilities.map((capability: Record<string, any>) => ({ creatorMlProfileId: ml.id, platform: capability.platform as Platform, format: capability.format })) });
        await tx.creatorCommercialRate.createMany({ data: source.commercial_rates.map((rate: Record<string, any>) => ({ creatorMlProfileId: ml.id, platform: rate.platform as Platform, format: rate.format, amount: rate.base_rate.amount, currency: rate.base_rate.currency, normalizedUsd: rate.base_rate.normalized_usd, rateVersion: rate.base_rate.rate_version, purpose: rate.base_rate.purpose, includes: rate.includes, usageRightsMultipliers: rate.usage_rights_multiplier, categoryExclusivity30DaysMultiplier: rate.category_exclusivity_30_days_multiplier })) });
      }
    }

    const opportunityMlIds = new Map<string, string>();
    for (const item of plan.opportunityPlan) {
      const source = item.source;
      const brandId = brandIds.get(source.brand_id)!;
      let opportunityId = item.mapped?.opportunityId;
      if (!opportunityId) {
        const first = new Date(source.timeline.first_draft_due);
        const briefing = new Date(source.timeline.briefing_date);
        const opportunity = await tx.opportunity.create({ data: { brandId, title: source.title, brief: source.brief, category: source.category, budgetKobo: moneyToKobo(source.budget), deadlineDays: Math.max(1, Math.round((first.getTime() - briefing.getTime()) / 864e5)), deliverables: source.deliverables.map((d: Record<string, any>) => `${d.quantity} ${d.platform} ${d.format}`), visibility: 'PUBLIC', status: 'PUBLISHED' } });
        opportunityId = opportunity.id;
      }
      const data = { sourceRecordHash: item.hash, sourceBrandId: source.brand_id, schemaVersion: dataset.manifest.schema_version, synthetic: true, industry: source.industry, product: source.product, objective: source.objective, tone: source.tone, creativeConcept: source.creative_concept, crossCategoryRationale: source.cross_category_rationale, callToAction: source.call_to_action, budgetAmount: source.budget.amount, budgetCurrency: source.budget.currency, budgetNormalizedUsd: source.budget.normalized_usd, budgetRateVersion: source.budget.rate_version, budgetPurpose: source.budget.purpose, budgetScope: source.budget_scope, compatibleNiches: source.compatible_niches, preferredLanguages: source.preferred_languages, preferredPlatforms: source.preferred_platforms, requiredLanguages: source.required_languages, requiredPlatforms: source.required_platforms, keyMessages: source.key_messages, successMetrics: source.success_metrics, targetAudienceDescription: source.target_audience.description, targetAudienceInterests: source.target_audience.interests, targetAudienceMarkets: source.target_audience.markets, deliverables: source.deliverables, usageRights: source.usage_rights, timeline: source.timeline, brandSnapshot: source.brand_snapshot, heldOut: source.held_out };
      const ml = await tx.opportunityMlProfile.upsert({ where: { namespace_sourceOpportunityId: { namespace: EXPECTED_NAMESPACE, sourceOpportunityId: source.id } }, create: { opportunityId, namespace: EXPECTED_NAMESPACE, sourceOpportunityId: source.id, ...data }, update: data });
      opportunityMlIds.set(source.id, ml.id);
    }

    for (const item of plan.eventPlan) {
      if (item.mapped && item.mapped.sourceRecordHash === item.hash) continue;
      const source = item.source;
      const data = { sourceRecordHash: item.hash, schemaVersion: dataset.manifest.schema_version, synthetic: true, sourceJourneyId: source.journey_id, sourceContractId: source.contract_id, previousSourceEventId: source.previous_event_id, sequence: dataset.eventSequence.get(source.id)!, eventType: source.event_type, occurredAt: new Date(`${source.occurred_at}T00:00:00.000Z`), details: source.details, creatorMlProfileId: creatorMlIds.get(source.creator_id)!, opportunityMlProfileId: opportunityMlIds.get(source.opportunity_id)! };
      await tx.demoMlEvidenceEvent.upsert({ where: { namespace_sourceEventId: { namespace: EXPECTED_NAMESPACE, sourceEventId: source.id } }, create: { namespace: EXPECTED_NAMESPACE, sourceEventId: source.id, ...data }, update: data });
    }
    await tx.demoDatasetImport.create({ data: { namespace: EXPECTED_NAMESPACE, schemaVersion: dataset.manifest.schema_version, generatorVersion: dataset.manifest.generator_version, manifestSha256: dataset.manifestSha256, datasetFingerprint: dataset.datasetFingerprint, databaseFingerprint: target.fingerprint, importerVersion: IMPORTER_VERSION, status: 'completed', counts: report as unknown as Prisma.InputJsonValue, conflicts: report.conflictDetails, startedAt, completedAt: new Date() } });
  }, { maxWait: 10_000, timeout: 300_000 });
}

try {
  const plan = await inspect();
  await execute(plan);
  console.log(JSON.stringify(report, null, 2));
  if (report.conflictDetails.length) process.exitCode = 2;
} finally {
  await prisma.$disconnect();
}
