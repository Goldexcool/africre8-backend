import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Platform } from '../src/generated/prisma/client.js';
import {
  OPERATIONAL_ML_NAMESPACE,
  assertApprovedEnrichmentTarget,
  mapOperationalCreator,
  mapOperationalOpportunity,
} from './ml-enrichment/core.js';

const arg = (name: string) =>
  process.argv
    .find((value) => value.startsWith(`${name}=`))
    ?.slice(name.length + 1);
const write = process.argv.includes('--write');
const batchSize = Number(arg('--batch-size') ?? 50);
if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100)
  throw new Error('--batch-size must be an integer from 1 to 100');

const target = assertApprovedEnrichmentTarget({
  databaseUrl: process.env.DATABASE_URL,
  expectedFingerprint: process.env.ML_ENRICHMENT_TARGET_FINGERPRINT,
  confirmedFingerprint: arg('--confirm-fingerprint'),
  targetLabel: process.env.ML_ENRICHMENT_TARGET_LABEL,
  confirmedTargetLabel: arg('--confirm-target-label'),
  enabled: process.env.ML_ENRICHMENT_ENABLED,
  confirmation: arg('--confirm-enrichment'),
  backupConfirmed: process.env.ML_ENRICHMENT_BACKUP_CONFIRMED,
  backupReference: process.env.ML_ENRICHMENT_BACKUP_REFERENCE,
  confirmedBackupReference: arg('--confirm-backup-reference'),
  write,
});

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});
const report = {
  mode: write ? 'write' : 'dry-run',
  target: {
    label: process.env.ML_ENRICHMENT_TARGET_LABEL,
    fingerprint: target.fingerprint,
  },
  creators: { insert: 0, update: 0, skip: 0, conflict: 0 },
  opportunities: { insert: 0, update: 0, skip: 0, conflict: 0 },
  defaults: {
    creatorsWithoutPlatforms: 0,
    creatorsWithoutRates: 0,
    opportunitiesWithoutExplicitPlatforms: 0,
  },
  conflicts: [] as { type: string; id: string; reason: string }[],
  guarantees: {
    usersChanged: 0,
    operationalRecordsChanged: 0,
    credibilityEventsCreated: 0,
    paymentsChanged: 0,
  },
};

try {
  const [creators, opportunities, brandProfiles] = await Promise.all([
    prisma.creatorProfile.findMany({
      include: { socials: true, mlProfile: true },
      orderBy: { userId: 'asc' },
    }),
    prisma.opportunity.findMany({
      include: { mlProfile: true },
      orderBy: { id: 'asc' },
    }),
    prisma.brandProfile.findMany({ select: { userId: true, industry: true } }),
  ]);
  const industryByBrand = new Map(
    brandProfiles.map((row) => [row.userId, row.industry]),
  );
  const creatorPlans: any[] = [];
  const opportunityPlans: any[] = [];

  for (const creator of creators) {
    const mapped = mapOperationalCreator(creator);
    if (!mapped.capabilities.length) report.defaults.creatorsWithoutPlatforms++;
    if (!mapped.rates.length) report.defaults.creatorsWithoutRates++;
    if (
      creator.mlProfile &&
      (creator.mlProfile.namespace !== OPERATIONAL_ML_NAMESPACE ||
        creator.mlProfile.synthetic)
    ) {
      report.creators.conflict++;
      report.conflicts.push({
        type: 'creator',
        id: creator.userId,
        reason: `existing ML profile belongs to ${creator.mlProfile.namespace}`,
      });
      continue;
    }
    const action = !creator.mlProfile
      ? 'insert'
      : creator.mlProfile.sourceRecordHash === mapped.sourceHash
        ? 'skip'
        : 'update';
    report.creators[action]++;
    creatorPlans.push({ creator, mapped, action });
  }

  for (const opportunity of opportunities) {
    const mapped = mapOperationalOpportunity({
      ...opportunity,
      brandIndustry: industryByBrand.get(opportunity.brandId),
    });
    if ('conflict' in mapped) {
      report.opportunities.conflict++;
      report.defaults.opportunitiesWithoutExplicitPlatforms++;
      report.conflicts.push({
        type: 'opportunity',
        id: opportunity.id,
        reason: mapped.conflict,
      });
      continue;
    }
    if (
      opportunity.mlProfile &&
      (opportunity.mlProfile.namespace !== OPERATIONAL_ML_NAMESPACE ||
        opportunity.mlProfile.synthetic)
    ) {
      report.opportunities.conflict++;
      report.conflicts.push({
        type: 'opportunity',
        id: opportunity.id,
        reason: `existing ML profile belongs to ${opportunity.mlProfile.namespace}`,
      });
      continue;
    }
    const action = !opportunity.mlProfile
      ? 'insert'
      : opportunity.mlProfile.sourceRecordHash === mapped.sourceHash
        ? 'skip'
        : 'update';
    report.opportunities[action]++;
    opportunityPlans.push({ opportunity, mapped, action });
  }

  if (write && report.conflicts.length)
    throw new Error(
      `write refused: resolve ${report.conflicts.length} conflict(s) from dry-run output`,
    );

  if (write) {
    for (let offset = 0; offset < creatorPlans.length; offset += batchSize) {
      await prisma.$transaction(
        async (tx) => {
          for (const plan of creatorPlans.slice(offset, offset + batchSize)) {
            if (plan.action === 'skip') continue;
            const ml =
              plan.action === 'insert'
                ? await tx.creatorMlProfile.create({
                    data: {
                      creatorId: plan.creator.userId,
                      ...plan.mapped.scalar,
                    },
                  })
                : await tx.creatorMlProfile.update({
                    where: { creatorId: plan.creator.userId },
                    data: plan.mapped.scalar,
                  });
            for (const item of plan.mapped.capabilities)
              await tx.creatorDeliverableCapability.upsert({
                where: {
                  creatorMlProfileId_platform_format: {
                    creatorMlProfileId: ml.id,
                    platform: item.platform as Platform,
                    format: item.format,
                  },
                },
                create: {
                  creatorMlProfileId: ml.id,
                  platform: item.platform as Platform,
                  format: item.format,
                },
                update: {},
              });
            for (const item of plan.mapped.rates)
              await tx.creatorCommercialRate.upsert({
                where: {
                  creatorMlProfileId_platform_format_rateVersion: {
                    creatorMlProfileId: ml.id,
                    platform: item.platform as Platform,
                    format: item.format,
                    rateVersion: item.rateVersion,
                  },
                },
                create: {
                  creatorMlProfileId: ml.id,
                  ...item,
                  platform: item.platform as Platform,
                },
                update: item,
              });
          }
        },
        { maxWait: 10_000, timeout: 120_000 },
      );
    }
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
            if (plan.action === 'skip') continue;
            await tx.opportunityMlProfile.upsert({
              where: { opportunityId: plan.opportunity.id },
              create: {
                opportunityId: plan.opportunity.id,
                ...plan.mapped.scalar,
              },
              update: plan.mapped.scalar,
            });
          }
        },
        { maxWait: 10_000, timeout: 120_000 },
      );
    }
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.conflicts.length) process.exitCode = 2;
} finally {
  await prisma.$disconnect();
}
