import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import {
  OPERATIONAL_ML_NAMESPACE,
  assertApprovedEnrichmentTarget,
} from './ml-enrichment/core.js';

const arg = (name: string) =>
  process.argv
    .find((value) => value.startsWith(`${name}=`))
    ?.slice(name.length + 1);
const target = assertApprovedEnrichmentTarget({
  databaseUrl: process.env.DATABASE_URL,
  expectedFingerprint: process.env.ML_ENRICHMENT_TARGET_FINGERPRINT,
  confirmedFingerprint: arg('--confirm-fingerprint'),
  targetLabel: process.env.ML_ENRICHMENT_TARGET_LABEL,
  confirmedTargetLabel: arg('--confirm-target-label'),
  write: false,
});
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

try {
  const [
    creators,
    opportunities,
    creatorProfiles,
    opportunityProfiles,
    syntheticEvidenceOnOperationalProfiles,
  ] = await Promise.all([
    prisma.creatorProfile.count(),
    prisma.opportunity.count(),
    prisma.creatorMlProfile.count({
      where: { namespace: OPERATIONAL_ML_NAMESPACE, synthetic: false },
    }),
    prisma.opportunityMlProfile.count({
      where: { namespace: OPERATIONAL_ML_NAMESPACE, synthetic: false },
    }),
    prisma.demoMlEvidenceEvent.count({
      where: {
        synthetic: true,
        creatorMlProfile: {
          namespace: OPERATIONAL_ML_NAMESPACE,
          synthetic: false,
        },
      },
    }),
  ]);
  const [
    creatorConflicts,
    opportunityConflicts,
    unusableCreators,
    unusableOpportunities,
  ] = await Promise.all([
    prisma.creatorProfile.count({
      where: {
        mlProfile: {
          is: {
            OR: [
              { namespace: { not: OPERATIONAL_ML_NAMESPACE } },
              { synthetic: true },
            ],
          },
        },
      },
    }),
    prisma.opportunity.count({
      where: {
        mlProfile: {
          is: {
            OR: [
              { namespace: { not: OPERATIONAL_ML_NAMESPACE } },
              { synthetic: true },
            ],
          },
        },
      },
    }),
    prisma.creatorMlProfile.count({
      where: {
        namespace: OPERATIONAL_ML_NAMESPACE,
        synthetic: false,
        OR: [
          { deliverableCapabilities: { none: {} } },
          { commercialRates: { none: {} } },
        ],
      },
    }),
    prisma.opportunityMlProfile.count({
      where: {
        namespace: OPERATIONAL_ML_NAMESPACE,
        synthetic: false,
        requiredPlatforms: { isEmpty: true },
      },
    }),
  ]);
  const result = {
    valid:
      creatorProfiles + creatorConflicts === creators &&
      opportunityProfiles + opportunityConflicts === opportunities &&
      syntheticEvidenceOnOperationalProfiles === 0,
    target: {
      label: process.env.ML_ENRICHMENT_TARGET_LABEL,
      fingerprint: target.fingerprint,
    },
    counts: {
      creators,
      creatorProfiles,
      creatorConflicts,
      opportunities,
      opportunityProfiles,
      opportunityConflicts,
    },
    limitations: {
      creatorsWithoutCapabilitiesOrRates: unusableCreators,
      opportunitiesWithoutRequiredPlatforms: unusableOpportunities,
    },
    evidenceIsolation: {
      syntheticEvidenceLinkedToOperationalProfiles:
        syntheticEvidenceOnOperationalProfiles,
    },
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.valid) process.exitCode = 2;
} finally {
  await prisma.$disconnect();
}
