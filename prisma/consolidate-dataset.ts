import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  Prisma,
  PrismaClient,
  type Platform,
} from '../src/generated/prisma/client.js';
import {
  loadAndValidateDataset,
  recordHash,
  syntheticCreatorAvatarUrl,
  syntheticEmail,
  unusablePasswordHash,
} from './demo-import/core.js';
import {
  mapOperationalCreator,
  mapOperationalOpportunity,
} from './ml-enrichment/core.js';
import {
  CONSOLIDATION_NAMESPACE,
  CONSOLIDATION_VERSION,
  assertApprovedConsolidationTarget,
  consolidationPlanHash,
  loadConsolidationScope,
  mapSyntheticCreator,
  mapSyntheticOpportunity,
  productionFingerprint,
  validateScopeAgainstDataset,
} from './consolidation/core.js';

const arg = (name: string) =>
  process.argv
    .find((value) => value.startsWith(`${name}=`))
    ?.slice(name.length + 1);
const write = process.argv.includes('--write');
const scopePath = arg('--scope');
if (!scopePath) throw new Error('--scope=<reviewed-scope.json> is required');
const batchSize = Number(arg('--batch-size') ?? 25);
if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 50)
  throw new Error('--batch-size must be an integer from 1 to 50');

const dataset = loadAndValidateDataset(
  arg('--data') ?? 'services/ml/data/demo-v2',
);
const scope = loadConsolidationScope(scopePath);
validateScopeAgainstDataset(scope, dataset);
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

type Conflict = { type: string; sourceId: string; reason: string };
type Plan = {
  kind: 'production' | 'mapped' | 'synthetic';
  sourceId: string;
  targetId?: string;
  source: any;
  mapped: any;
};

const toKobo = (source: any) =>
  Math.round(Number(source.budget.normalized_usd) * 1500 * 100);

try {
  const [
    users,
    creators,
    brands,
    opportunities,
    campaigns,
    transactions,
    provenance,
  ] = await Promise.all([
    prisma.user.findMany({
      select: {
        id: true,
        email: true,
        role: true,
        passwordHash: true,
        status: true,
        verificationStatus: true,
        onboardedAt: true,
      },
      orderBy: { id: 'asc' },
    }),
    prisma.creatorProfile.findMany({
      include: {
        socials: true,
        mlProfile: {
          include: { _count: { select: { evidenceEvents: true } } },
        },
      },
      orderBy: { userId: 'asc' },
    }),
    prisma.brandProfile.findMany({ orderBy: { userId: 'asc' } }),
    prisma.opportunity.findMany({
      include: { mlProfile: true },
      orderBy: { id: 'asc' },
    }),
    prisma.campaign.findMany({
      select: {
        id: true,
        matchId: true,
        brandId: true,
        creatorId: true,
        status: true,
        amountKobo: true,
      },
      orderBy: { id: 'asc' },
    }),
    prisma.transaction.findMany({
      select: {
        id: true,
        campaignId: true,
        kind: true,
        amountKobo: true,
        status: true,
        idempotencyKey: true,
      },
      orderBy: { id: 'asc' },
    }),
    prisma.datasetRecordProvenance.findMany({
      where: { namespace: CONSOLIDATION_NAMESPACE },
    }),
  ]);
  const syntheticCreatorEntityIds = new Set(
    provenance
      .filter((row) => row.entityType === 'creator' && row.synthetic)
      .map((row) => row.entityId),
  );
  const syntheticBrandEntityIds = new Set(
    provenance
      .filter((row) => row.entityType === 'brand' && row.synthetic)
      .map((row) => row.entityId),
  );
  const syntheticOpportunityEntityIds = new Set(
    provenance
      .filter((row) => row.entityType === 'opportunity' && row.synthetic)
      .map((row) => row.entityId),
  );
  const syntheticUserIds = new Set([
    ...syntheticCreatorEntityIds,
    ...syntheticBrandEntityIds,
  ]);
  const snapshot = {
    users: users
      .filter((row) => !syntheticUserIds.has(row.id))
      .map((row) => ({
        ...row,
        passwordHash: recordHash(row.passwordHash),
      })),
    creators: creators
      .filter((row) => !syntheticCreatorEntityIds.has(row.userId))
      .map(({ mlProfile: _mlProfile, ...row }) => row),
    brands: brands.filter((row) => !syntheticBrandEntityIds.has(row.userId)),
    opportunities: opportunities
      .filter((row) => !syntheticOpportunityEntityIds.has(row.id))
      .map(({ mlProfile: _mlProfile, ...row }) => row),
    campaigns,
    transactions,
  };
  const productionSnapshotFingerprint = productionFingerprint(snapshot);
  const conflicts: Conflict[] = [];
  const userById = new Map(users.map((row) => [row.id, row]));
  const userByEmail = new Map(
    users.map((row) => [row.email.toLowerCase(), row]),
  );
  const creatorById = new Map(creators.map((row) => [row.userId, row]));
  const brandById = new Map(brands.map((row) => [row.userId, row]));
  const opportunityById = new Map(opportunities.map((row) => [row.id, row]));
  const provenanceBySource = new Map(
    provenance.map((row) => [`${row.entityType}:${row.sourceId}`, row]),
  );
  for (const [sourceId, targetId] of Object.entries(
    scope.creatorIdentityMappings,
  ))
    if (!creatorById.has(targetId))
      conflicts.push({
        type: 'creator_mapping',
        sourceId,
        reason: `target creator ${targetId} does not exist`,
      });
  for (const [sourceId, targetId] of Object.entries(
    scope.brandIdentityMappings,
  ))
    if (!brandById.has(targetId))
      conflicts.push({
        type: 'brand_mapping',
        sourceId,
        reason: `target brand ${targetId} does not exist`,
      });
  for (const [sourceId, targetId] of Object.entries(
    scope.opportunityIdentityMappings,
  ))
    if (!opportunityById.has(targetId))
      conflicts.push({
        type: 'opportunity_mapping',
        sourceId,
        reason: `target opportunity ${targetId} does not exist`,
      });

  const creatorPlans: Plan[] = [];
  const mappedCreatorTargets = new Map(
    Object.entries(scope.creatorIdentityMappings).map(
      ([sourceId, targetId]) => [targetId, sourceId],
    ),
  );
  for (const creator of creators) {
    if (syntheticCreatorEntityIds.has(creator.userId)) continue;
    const syntheticSourceId = mappedCreatorTargets.get(creator.userId);
    const source = syntheticSourceId
      ? dataset.creators.find((row) => row.id === syntheticSourceId)!
      : creator;
    const mapped = syntheticSourceId
      ? mapSyntheticCreator(source, false)
      : (() => {
          const operational = mapOperationalCreator(creator);
          return {
            ...operational,
            scalar: {
              ...operational.scalar,
              namespace: CONSOLIDATION_NAMESPACE,
              sourceCreatorId: `production:${creator.userId}`,
              schemaVersion: CONSOLIDATION_VERSION,
            },
            markets: [],
          };
        })();
    if (creator.mlProfile?._count.evidenceEvents)
      conflicts.push({
        type: 'credibility_provenance',
        sourceId: creator.userId,
        reason:
          'existing evidence on a retained real identity requires manual provenance review',
      });
    creatorPlans.push({
      kind: syntheticSourceId ? 'mapped' : 'production',
      sourceId: syntheticSourceId ?? creator.userId,
      targetId: creator.userId,
      source,
      mapped,
    });
  }
  for (const sourceId of scope.syntheticCreatorIds) {
    const source = dataset.creators.find((row) => row.id === sourceId)!;
    const existingProvenance = provenanceBySource.get(`creator:${sourceId}`);
    const email = syntheticEmail('creator', sourceId);
    const emailOwner = userByEmail.get(email);
    if (emailOwner && emailOwner.id !== existingProvenance?.entityId)
      conflicts.push({
        type: 'synthetic_creator',
        sourceId,
        reason: `synthetic email is owned by unrelated user ${emailOwner.id}`,
      });
    creatorPlans.push({
      kind: 'synthetic',
      sourceId,
      targetId: existingProvenance?.entityId,
      source,
      mapped: mapSyntheticCreator(source, true),
    });
  }

  const brandPlans: Plan[] = scope.syntheticBrandIds.map((sourceId) => {
    const source = dataset.brands.find((row) => row.id === sourceId)!;
    const existing = provenanceBySource.get(`brand:${sourceId}`);
    const email = syntheticEmail('brand', sourceId);
    const emailOwner = userByEmail.get(email);
    if (emailOwner && emailOwner.id !== existing?.entityId)
      conflicts.push({
        type: 'synthetic_brand',
        sourceId,
        reason: `synthetic email is owned by unrelated user ${emailOwner.id}`,
      });
    return {
      kind: 'synthetic',
      sourceId,
      targetId: existing?.entityId,
      source,
      mapped: null,
    };
  });

  const mappedOpportunityTargets = new Map(
    Object.entries(scope.opportunityIdentityMappings).map(
      ([sourceId, targetId]) => [targetId, sourceId],
    ),
  );
  const opportunityPlans: Plan[] = [];
  for (const opportunity of opportunities) {
    if (syntheticOpportunityEntityIds.has(opportunity.id)) continue;
    const syntheticSourceId = mappedOpportunityTargets.get(opportunity.id);
    if (syntheticSourceId) {
      const source = dataset.opportunities.find(
        (row) => row.id === syntheticSourceId,
      )!;
      opportunityPlans.push({
        kind: 'mapped',
        sourceId: syntheticSourceId,
        targetId: opportunity.id,
        source,
        mapped: mapSyntheticOpportunity(source, false),
      });
      continue;
    }
    const operational = mapOperationalOpportunity({
      ...opportunity,
      brandIndustry: brandById.get(opportunity.brandId)?.industry,
    });
    if ('conflict' in operational) {
      conflicts.push({
        type: 'production_opportunity',
        sourceId: opportunity.id,
        reason: operational.conflict,
      });
      continue;
    }
    opportunityPlans.push({
      kind: 'production',
      sourceId: opportunity.id,
      targetId: opportunity.id,
      source: opportunity,
      mapped: {
        ...operational.scalar,
        namespace: CONSOLIDATION_NAMESPACE,
        sourceOpportunityId: `production:${opportunity.id}`,
        schemaVersion: CONSOLIDATION_VERSION,
      },
    });
  }
  for (const sourceId of scope.syntheticOpportunityIds) {
    const source = dataset.opportunities.find((row) => row.id === sourceId)!;
    opportunityPlans.push({
      kind: 'synthetic',
      sourceId,
      targetId: provenanceBySource.get(`opportunity:${sourceId}`)?.entityId,
      source,
      mapped: mapSyntheticOpportunity(source, true),
    });
  }

  const approvedEvidence = dataset.interactions.filter((row) =>
    scope.syntheticEvidenceCreatorIds.includes(row.creator_id),
  );
  const planInput = {
    namespace: CONSOLIDATION_NAMESPACE,
    productionSnapshotFingerprint,
    syntheticFingerprint: dataset.datasetFingerprint,
    scope,
    operations: {
      creators: creatorPlans.map((row) => ({
        kind: row.kind,
        sourceId: row.sourceId,
        targetId: row.targetId,
        hash: row.mapped.scalar.sourceRecordHash,
      })),
      brands: brandPlans.map((row) => ({
        sourceId: row.sourceId,
        targetId: row.targetId,
        hash: recordHash(row.source),
      })),
      opportunities: opportunityPlans.map((row) => ({
        kind: row.kind,
        sourceId: row.sourceId,
        targetId: row.targetId,
        hash: row.mapped.sourceRecordHash,
      })),
      evidence: approvedEvidence.map((row) => row.id),
    },
  };
  const planHash = consolidationPlanHash(planInput);
  const target = assertApprovedConsolidationTarget({
    databaseUrl: process.env.DATABASE_URL,
    targetLabel: process.env.CONSOLIDATION_TARGET_LABEL,
    confirmedTargetLabel: arg('--confirm-target-label'),
    expectedTargetFingerprint: process.env.CONSOLIDATION_TARGET_FINGERPRINT,
    confirmedTargetFingerprint: arg('--confirm-target-fingerprint'),
    actualProductionFingerprint: productionSnapshotFingerprint,
    confirmedProductionFingerprint: arg('--confirm-production-fingerprint'),
    actualPlanHash: planHash,
    confirmedPlanHash: arg('--confirm-plan-hash'),
    enabled: process.env.CONSOLIDATION_ENABLED,
    confirmation: arg('--confirm-consolidation'),
    backupConfirmed: process.env.CONSOLIDATION_BACKUP_CONFIRMED,
    backupReference: process.env.CONSOLIDATION_BACKUP_REFERENCE,
    confirmedBackupReference: arg('--confirm-backup-reference'),
    write,
  });
  const report = {
    mode: write ? 'write' : 'dry-run',
    namespace: CONSOLIDATION_NAMESPACE,
    target: {
      label: process.env.CONSOLIDATION_TARGET_LABEL,
      fingerprint: target.fingerprint,
    },
    productionSnapshotFingerprint,
    syntheticDatasetFingerprint: dataset.datasetFingerprint,
    scopeHash: recordHash(scope),
    planHash,
    retainedProduction: {
      users: snapshot.users.length,
      creators: snapshot.creators.length,
      brands: snapshot.brands.length,
      opportunities: snapshot.opportunities.length,
      campaigns: campaigns.length,
      transactions: transactions.length,
    },
    approvedSynthetic: {
      creators: scope.syntheticCreatorIds.length,
      brands: scope.syntheticBrandIds.length,
      opportunities: scope.syntheticOpportunityIds.length,
      evidenceCreators: scope.syntheticEvidenceCreatorIds.length,
      evidenceEvents: approvedEvidence.length,
    },
    identityMappings: {
      creators: Object.keys(scope.creatorIdentityMappings).length,
      brands: Object.keys(scope.brandIdentityMappings).length,
      opportunities: Object.keys(scope.opportunityIdentityMappings).length,
    },
    controlledMlReconciliation: {
      creatorProfiles: creatorPlans.length,
      opportunityProfiles: opportunityPlans.length,
      capabilityAndRateRowsReplacedOnlyWithinUnifiedProfiles: true,
    },
    conflicts,
    forbiddenSideEffects: {
      userCredentialUpdates: 0,
      productionRecordDeletes: 0,
      paymentWrites: 0,
      notificationWrites: 0,
      outboundCalls: 0,
    },
  };
  if (write && conflicts.length)
    throw new Error(
      `write refused: ${conflicts.length} reconciliation conflict(s)`,
    );

  if (write) {
    const startedAt = new Date();
    const run = await prisma.datasetConsolidationRun.upsert({
      where: { planHash },
      create: {
        namespace: CONSOLIDATION_NAMESPACE,
        planHash,
        productionFingerprint: productionSnapshotFingerprint,
        syntheticFingerprint: dataset.datasetFingerprint,
        targetDatabaseFingerprint: target.fingerprint,
        scope: scope as unknown as Prisma.InputJsonValue,
        counts: report as unknown as Prisma.InputJsonValue,
        conflicts: conflicts as unknown as Prisma.InputJsonValue,
        backupReference: process.env.CONSOLIDATION_BACKUP_REFERENCE!,
        status: 'started',
        startedAt,
      },
      update: {
        status: 'started',
        startedAt,
        completedAt: null,
        counts: report as unknown as Prisma.InputJsonValue,
      },
    });
    const provenanceUpsert = async (
      tx: any,
      entityType: string,
      entityId: string,
      sourceKind: string,
      sourceId: string,
      source: any,
      synthetic: boolean,
    ) =>
      tx.datasetRecordProvenance.upsert({
        where: {
          namespace_entityType_entityId: {
            namespace: CONSOLIDATION_NAMESPACE,
            entityType,
            entityId,
          },
        },
        create: {
          namespace: CONSOLIDATION_NAMESPACE,
          entityType,
          entityId,
          sourceKind,
          sourceId,
          sourceRecordHash: recordHash(source),
          synthetic,
          consolidationRunId: run.id,
        },
        update: {
          sourceKind,
          sourceId,
          sourceRecordHash: recordHash(source),
          synthetic,
          consolidationRunId: run.id,
        },
      });

    const brandIds = new Map<string, string>(
      Object.entries(scope.brandIdentityMappings),
    );
    for (const plan of brandPlans) {
      await prisma.$transaction(async (tx) => {
        let entityId = plan.targetId;
        if (!entityId) {
          const user = await tx.user.create({
            data: {
              email: syntheticEmail('brand', plan.sourceId),
              passwordHash: unusablePasswordHash(),
              role: 'BRAND',
              status: 'ACTIVE',
              verificationStatus: 'UNVERIFIED',
            },
          });
          entityId = user.id;
          await tx.brandProfile.create({
            data: {
              userId: entityId,
              businessName: plan.source.name,
              industry: plan.source.industry,
              location: `${plan.source.headquarters.city}, ${plan.source.headquarters.country_code}`,
              about: `${plan.source.positioning}. Synthetic demo identity.`,
            },
          });
        }
        brandIds.set(plan.sourceId, entityId);
        await provenanceUpsert(
          tx,
          'brand',
          entityId,
          'synthetic',
          plan.sourceId,
          plan.source,
          true,
        );
      });
    }

    const creatorIds = new Map<string, string>(
      Object.entries(scope.creatorIdentityMappings),
    );
    for (let offset = 0; offset < creatorPlans.length; offset += batchSize) {
      await prisma.$transaction(
        async (tx) => {
          for (const plan of creatorPlans.slice(offset, offset + batchSize)) {
            let entityId = plan.targetId;
            if (plan.kind === 'synthetic' && !entityId) {
              const user = await tx.user.create({
                data: {
                  email: syntheticEmail('creator', plan.sourceId),
                  passwordHash: unusablePasswordHash(),
                  role: 'CREATOR',
                  status: 'ACTIVE',
                  verificationStatus: 'VERIFIED',
                  emailVerifiedAt: new Date(),
                  onboardedAt: new Date(),
                  openToInvites: true,
                },
              });
              entityId = user.id;
              const rates = plan.source.commercial_rates.map((row: any) =>
                Number(row.base_rate.normalized_usd),
              );
              await tx.creatorProfile.create({
                data: {
                  userId: entityId,
                  displayName: plan.source.display_name,
                  avatarUrl: syntheticCreatorAvatarUrl(
                    process.env.PUBLIC_URL,
                    plan.sourceId,
                  ),
                  bio: plan.source.bio,
                  location: `${plan.source.residence.city}, ${plan.source.residence.country}`,
                  category: plan.source.category,
                  niches: plan.source.niches,
                  portfolio: [],
                  priceFromKobo: Math.round(Math.min(...rates) * 1500 * 100),
                  priceToKobo: Math.round(Math.max(...rates) * 1500 * 100),
                  availability:
                    plan.source.availability === 'limited'
                      ? 'busy'
                      : plan.source.availability,
                },
              });
              await tx.socialAccount.createMany({
                data: plan.source.socials.map((row: any) => ({
                  creatorId: entityId,
                  platform: row.platform as Platform,
                  handle: row.handle,
                  followers: row.followers,
                  engagementRate: row.engagement_rate_percent,
                })),
              });
            }
            entityId ??= plan.targetId;
            if (!entityId)
              throw new Error(
                `creator ${plan.sourceId} has no resolved target`,
              );
            if (plan.kind === 'synthetic')
              await tx.creatorProfile.updateMany({
                where: { userId: entityId, avatarUrl: null },
                data: {
                  avatarUrl: syntheticCreatorAvatarUrl(
                    process.env.PUBLIC_URL,
                    plan.sourceId,
                  ),
                },
              });
            creatorIds.set(plan.sourceId, entityId);
            const ml = await tx.creatorMlProfile.upsert({
              where: { creatorId: entityId },
              create: { creatorId: entityId, ...plan.mapped.scalar },
              update: plan.mapped.scalar,
            });
            await tx.creatorAudienceMarket.deleteMany({
              where: { creatorMlProfileId: ml.id },
            });
            await tx.creatorDeliverableCapability.deleteMany({
              where: { creatorMlProfileId: ml.id },
            });
            await tx.creatorCommercialRate.deleteMany({
              where: { creatorMlProfileId: ml.id },
            });
            if (plan.mapped.markets?.length)
              await tx.creatorAudienceMarket.createMany({
                data: plan.mapped.markets.map((row: any) => ({
                  creatorMlProfileId: ml.id,
                  ...row,
                })),
              });
            if (plan.mapped.capabilities.length)
              await tx.creatorDeliverableCapability.createMany({
                data: plan.mapped.capabilities.map((row: any) => ({
                  creatorMlProfileId: ml.id,
                  ...row,
                })),
              });
            if (plan.mapped.rates.length)
              await tx.creatorCommercialRate.createMany({
                data: plan.mapped.rates.map((row: any) => ({
                  creatorMlProfileId: ml.id,
                  ...row,
                })),
              });
            await provenanceUpsert(
              tx,
              'creator',
              entityId,
              plan.kind,
              plan.sourceId,
              plan.source,
              plan.kind === 'synthetic',
            );
          }
        },
        { maxWait: 10_000, timeout: 120_000 },
      );
    }

    const opportunityIds = new Map<string, string>(
      Object.entries(scope.opportunityIdentityMappings),
    );
    for (
      let offset = 0;
      offset < opportunityPlans.length;
      offset += batchSize
    ) {
      await prisma.$transaction(
        async (tx) => {
          for (const plan of opportunityPlans.slice(
            offset,
            offset + batchSize,
          )) {
            let entityId = plan.targetId;
            if (plan.kind === 'synthetic' && !entityId) {
              const brandId = brandIds.get(plan.source.brand_id);
              if (!brandId)
                throw new Error(
                  `synthetic opportunity ${plan.sourceId} has no resolved brand`,
                );
              const first = new Date(plan.source.timeline.first_draft_due);
              const briefing = new Date(plan.source.timeline.briefing_date);
              const opportunity = await tx.opportunity.create({
                data: {
                  brandId,
                  title: plan.source.title,
                  brief: plan.source.brief,
                  category: plan.source.category,
                  budgetKobo: toKobo(plan.source),
                  deadlineDays: Math.max(
                    1,
                    Math.round((first.getTime() - briefing.getTime()) / 864e5),
                  ),
                  deliverables: plan.source.deliverables.map(
                    (row: any) =>
                      `${row.quantity} ${row.platform} ${row.format}`,
                  ),
                  visibility: 'PUBLIC',
                  status: 'PUBLISHED',
                },
              });
              entityId = opportunity.id;
            }
            if (!entityId)
              throw new Error(
                `opportunity ${plan.sourceId} has no resolved target`,
              );
            opportunityIds.set(plan.sourceId, entityId);
            await tx.opportunityMlProfile.upsert({
              where: { opportunityId: entityId },
              create: { opportunityId: entityId, ...plan.mapped },
              update: plan.mapped,
            });
            await provenanceUpsert(
              tx,
              'opportunity',
              entityId,
              plan.kind,
              plan.sourceId,
              plan.source,
              plan.kind === 'synthetic',
            );
          }
        },
        { maxWait: 10_000, timeout: 120_000 },
      );
    }

    for (const event of approvedEvidence) {
      const creatorId = creatorIds.get(event.creator_id);
      const opportunityId = opportunityIds.get(event.opportunity_id);
      if (!creatorId || !opportunityId)
        throw new Error(`evidence ${event.id} has unresolved identities`);
      const [creatorMl, opportunityMl] = await Promise.all([
        prisma.creatorMlProfile.findUniqueOrThrow({ where: { creatorId } }),
        prisma.opportunityMlProfile.findUniqueOrThrow({
          where: { opportunityId },
        }),
      ]);
      await prisma.demoMlEvidenceEvent.upsert({
        where: {
          namespace_sourceEventId: {
            namespace: CONSOLIDATION_NAMESPACE,
            sourceEventId: event.id,
          },
        },
        create: {
          namespace: CONSOLIDATION_NAMESPACE,
          schemaVersion: CONSOLIDATION_VERSION,
          synthetic: true,
          sourceEventId: event.id,
          sourceRecordHash: recordHash(event),
          sourceJourneyId: event.journey_id,
          sourceContractId: event.contract_id,
          previousSourceEventId: event.previous_event_id,
          sequence: dataset.eventSequence.get(event.id)!,
          eventType: event.event_type,
          occurredAt: new Date(`${event.occurred_at}T00:00:00.000Z`),
          details: event.details,
          creatorMlProfileId: creatorMl.id,
          opportunityMlProfileId: opportunityMl.id,
        },
        update: {
          sourceRecordHash: recordHash(event),
          details: event.details,
          creatorMlProfileId: creatorMl.id,
          opportunityMlProfileId: opportunityMl.id,
        },
      });
    }
    await prisma.datasetConsolidationRun.update({
      where: { id: run.id },
      data: {
        status: 'completed',
        completedAt: new Date(),
        counts: report as unknown as Prisma.InputJsonValue,
      },
    });
  }

  console.log(JSON.stringify(report, null, 2));
  if (conflicts.length) process.exitCode = 2;
} finally {
  await prisma.$disconnect();
}
