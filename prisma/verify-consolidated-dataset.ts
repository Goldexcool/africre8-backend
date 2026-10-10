import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import {
  CONSOLIDATION_NAMESPACE,
  consolidationDatabaseIdentity,
} from './consolidation/core.js';

const arg = (name: string) =>
  process.argv
    .find((value) => value.startsWith(`${name}=`))
    ?.slice(name.length + 1);
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const target = consolidationDatabaseIdentity(process.env.DATABASE_URL);
if (!process.env.CONSOLIDATION_TARGET_LABEL)
  throw new Error('CONSOLIDATION_TARGET_LABEL is required');
if (process.env.CONSOLIDATION_TARGET_LABEL !== arg('--confirm-target-label'))
  throw new Error('target label confirmation is missing or incorrect');
if (process.env.CONSOLIDATION_TARGET_FINGERPRINT !== target.fingerprint)
  throw new Error(
    'CONSOLIDATION_TARGET_FINGERPRINT does not match DATABASE_URL',
  );
if (arg('--confirm-target-fingerprint') !== target.fingerprint)
  throw new Error(
    'CLI target fingerprint confirmation is missing or incorrect',
  );
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

try {
  const [
    users,
    creators,
    brands,
    opportunities,
    campaigns,
    transactions,
    notifications,
    creatorMl,
    opportunityMl,
    runs,
    evidence,
    provenance,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.creatorProfile.findMany({
      select: { userId: true, avatarUrl: true },
    }),
    prisma.brandProfile.count(),
    prisma.opportunity.count(),
    prisma.campaign.count(),
    prisma.transaction.count(),
    prisma.notification.count(),
    prisma.creatorMlProfile.findMany({
      select: {
        creatorId: true,
        namespace: true,
        synthetic: true,
        deliverableCapabilities: { select: { id: true } },
        commercialRates: { select: { id: true } },
      },
    }),
    prisma.opportunityMlProfile.findMany({
      select: {
        opportunityId: true,
        namespace: true,
        synthetic: true,
        requiredPlatforms: true,
      },
    }),
    prisma.datasetConsolidationRun.findMany({
      where: { namespace: CONSOLIDATION_NAMESPACE },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.demoMlEvidenceEvent.findMany({
      where: { namespace: CONSOLIDATION_NAMESPACE },
      select: {
        id: true,
        synthetic: true,
        creatorMlProfile: { select: { creatorId: true } },
      },
    }),
    prisma.datasetRecordProvenance.findMany({
      where: { namespace: CONSOLIDATION_NAMESPACE },
    }),
  ]);
  const syntheticCreators = new Set(
    provenance
      .filter((row) => row.entityType === 'creator' && row.synthetic)
      .map((row) => row.entityId),
  );
  const invalidSyntheticImages = creators.filter((row) => {
    if (!syntheticCreators.has(row.userId)) return false;
    if (!row.avatarUrl) return true;
    try {
      const url = new URL(row.avatarUrl);
      const fallback = url.pathname.startsWith('/demo-media/creators/') && url.pathname.endsWith('.svg');
      const portrait = url.pathname.startsWith('/media/africre8/demo/creators/') && url.pathname.endsWith('.webp');
      const pool = /^\/media\/africre8\/demo\/portrait-pool\/portrait-0(?:0[1-9]|10)\.webp$/.test(url.pathname);
      return !['http:', 'https:'].includes(url.protocol) || (!fallback && !portrait && !pool);
    } catch {
      return true;
    }
  });
  const retainedProductionCreators = creators.filter(
    (row) => !syntheticCreators.has(row.userId),
  );
  const evidenceViolations = evidence.filter(
    (row) =>
      !row.synthetic || !syntheticCreators.has(row.creatorMlProfile.creatorId),
  );
  const creatorCoverage = new Set(
    creatorMl
      .filter((row) => row.namespace === CONSOLIDATION_NAMESPACE)
      .map((row) => row.creatorId),
  ).size;
  const opportunityCoverage = new Set(
    opportunityMl
      .filter((row) => row.namespace === CONSOLIDATION_NAMESPACE)
      .map((row) => row.opportunityId),
  ).size;
  const missingCreatorFeatures = creatorMl.filter(
    (row) =>
      row.namespace === CONSOLIDATION_NAMESPACE &&
      (!row.deliverableCapabilities.length || !row.commercialRates.length),
  ).length;
  const missingOpportunityPlatforms = opportunityMl.filter(
    (row) =>
      row.namespace === CONSOLIDATION_NAMESPACE &&
      !row.requiredPlatforms.length,
  ).length;
  const latestRun = runs[0];
  const valid =
    !!latestRun &&
    latestRun.status === 'completed' &&
    creatorCoverage === creators.length &&
    opportunityCoverage === opportunities &&
    evidenceViolations.length === 0 &&
    invalidSyntheticImages.length === 0;
  const report = {
    valid,
    target: {
      label: process.env.CONSOLIDATION_TARGET_LABEL,
      fingerprint: target.fingerprint,
    },
    operationalCounts: {
      users,
      creators: creators.length,
      brands,
      opportunities,
      campaigns,
      transactions,
      notifications,
    },
    mlCoverage: {
      creators: creatorCoverage,
      opportunities: opportunityCoverage,
      creatorsMissingCapabilitiesOrRates: missingCreatorFeatures,
      opportunitiesMissingPlatforms: missingOpportunityPlatforms,
    },
    provenance: {
      records: provenance.length,
      syntheticCreators: syntheticCreators.size,
    },
    imageCoverage: {
      syntheticCreators: syntheticCreators.size,
      validSyntheticImageReferences:
        syntheticCreators.size - invalidSyntheticImages.length,
      invalidSyntheticImageReferences: invalidSyntheticImages.length,
      retainedProductionCreators: retainedProductionCreators.length,
      retainedProductionImageReferences: retainedProductionCreators.filter(
        (row) => !!row.avatarUrl,
      ).length,
      remoteObjectsChecked: false,
    },
    evidenceIsolation: {
      events: evidence.length,
      violations: evidenceViolations.length,
    },
    latestRun: latestRun
      ? {
          planHash: latestRun.planHash,
          status: latestRun.status,
          completedAt: latestRun.completedAt,
        }
      : null,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!valid) process.exitCode = 2;
} finally {
  await prisma.$disconnect();
}
