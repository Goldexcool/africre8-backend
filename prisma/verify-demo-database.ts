import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import {
  EXPECTED_NAMESPACE,
  assertApprovedDemoTarget,
  loadAndValidateDataset,
} from './demo-import/core.js';
import {
  deterministicUuid,
  eventOf,
  groupJourneys,
} from './demo-operational/core.js';

const arg = (name: string) =>
  process.argv
    .find((value) => value.startsWith(`${name}=`))
    ?.slice(name.length + 1);
const dataset = loadAndValidateDataset(
  arg('--data') ?? 'services/ml/data/demo-v2',
);
const target = assertApprovedDemoTarget({
  databaseUrl: process.env.DATABASE_URL,
  databaseEnvironment: process.env.DEMO_DATABASE_ENV,
  expectedFingerprint: process.env.DEMO_DATABASE_FINGERPRINT,
  confirmedFingerprint: arg('--confirm-fingerprint'),
  importEnabled: process.env.DEMO_DATA_IMPORT_ENABLED,
  nodeEnvironment: process.env.NODE_ENV,
  write: false,
});

const opportunityById = new Map(
  dataset.opportunities.map((row) => [row.id, row]),
);
const journeys = groupJourneys(dataset.interactions);
const expectedInterests = new Set<string>();
const expectedMatches = new Set<string>();
let expectedCampaigns = 0;
let expectedRequirements = 0;
for (const rows of journeys.values()) {
  const root = rows[0];
  const opportunity = opportunityById.get(root.opportunity_id)!;
  expectedInterests.add(
    `${opportunity.brand_id}:${root.creator_id}:${root.opportunity_id}`,
  );
  if (eventOf(rows, 'match'))
    expectedMatches.add(`${opportunity.brand_id}:${root.creator_id}`);
  const contract = eventOf(rows, 'contract');
  if (contract) {
    expectedCampaigns++;
    expectedRequirements += contract.details.deliverables.length;
  }
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});
try {
  const counts = {
    users: await prisma.user.count(),
    creators: await prisma.creatorProfile.count(),
    creatorImages: await prisma.creatorProfile.count({
      where: {
        OR: [
          { avatarUrl: { startsWith: `${(process.env.PUBLIC_URL ?? '').replace(/\/$/, '')}/demo-media/creators/` } },
          { avatarUrl: { startsWith: `${(process.env.PUBLIC_URL ?? '').replace(/\/$/, '')}/media/africre8/demo/creators/` } },
          { avatarUrl: { startsWith: `${(process.env.PUBLIC_URL ?? '').replace(/\/$/, '')}/media/africre8/demo/portrait-pool/` } },
        ],
      },
    }),
    brands: await prisma.brandProfile.count(),
    opportunities: await prisma.opportunity.count(),
    creatorMlProfiles: await prisma.creatorMlProfile.count({
      where: { namespace: EXPECTED_NAMESPACE, synthetic: true },
    }),
    opportunityMlProfiles: await prisma.opportunityMlProfile.count({
      where: { namespace: EXPECTED_NAMESPACE, synthetic: true },
    }),
    evidenceEvents: await prisma.demoMlEvidenceEvent.count({
      where: { namespace: EXPECTED_NAMESPACE, synthetic: true },
    }),
    interests: await prisma.interest.count(),
    matches: await prisma.match.count(),
    conversations: await prisma.conversation.count(),
    campaigns: await prisma.campaign.count(),
    requirements: await prisma.deliverableRequirement.count(),
    submissions: await prisma.submission.count(),
    verifications: await prisma.verificationRun.count(),
    disputes: await prisma.dispute.count(),
    transactions: await prisma.transaction.count(),
    webhooks: await prisma.webhookEvent.count(),
    payouts: await prisma.payoutDestination.count(),
    notifications: await prisma.notification.count(),
  };
  const expected = {
    users: 551,
    creators: 500,
    creatorImages: 500,
    brands: 50,
    opportunities: 150,
    creatorMlProfiles: 500,
    opportunityMlProfiles: 150,
    evidenceEvents: 3000,
    interests: expectedInterests.size,
    matches: expectedMatches.size,
    conversations: expectedMatches.size,
    campaigns: expectedCampaigns,
    requirements: expectedRequirements,
    submissions: 0,
    verifications: 0,
    disputes: 0,
    transactions: 0,
    webhooks: 0,
    payouts: 0,
    notifications: 0,
  };
  const mismatches = Object.entries(expected)
    .filter(([key, value]) => counts[key as keyof typeof counts] !== value)
    .map(
      ([key, value]) =>
        `${key}: expected ${value}, found ${counts[key as keyof typeof counts]}`,
    );
  const accounts = await prisma.user.findMany({
    where: { id: { in: [deterministicUuid('admin')] } },
    select: {
      email: true,
      role: true,
      passwordHash: true,
      emailVerifiedAt: true,
      onboardedAt: true,
    },
  });
  const [matches, acceptedInterests] = await Promise.all([
    prisma.match.findMany({
      select: { brandId: true, creatorId: true, opportunityId: true },
    }),
    prisma.interest.findMany({
      where: { status: 'ACCEPTED' },
      select: { brandId: true, creatorId: true, opportunityId: true },
    }),
  ]);
  const acceptedKeys = new Set(
    acceptedInterests.map(
      (row) => `${row.brandId}:${row.creatorId}:${row.opportunityId}`,
    ),
  );
  const matchesWithoutAcceptedInterest = matches.filter(
    (row) =>
      !acceptedKeys.has(`${row.brandId}:${row.creatorId}:${row.opportunityId}`),
  );
  if (matchesWithoutAcceptedInterest.length)
    mismatches.push(
      `${matchesWithoutAcceptedInterest.length} match(es) lack an accepted source interest`,
    );
  const demoCreator = await prisma.creatorMlProfile.findUnique({
    where: {
      namespace_sourceCreatorId: {
        namespace: EXPECTED_NAMESPACE,
        sourceCreatorId: dataset.creators[0].id,
      },
    },
    include: { creator: { include: { user: true } } },
  });
  const firstBrandOpportunity = dataset.opportunities.find(
    (row) => row.brand_id === dataset.brands[0].id,
  )!;
  const demoBrand = await prisma.opportunityMlProfile.findUnique({
    where: {
      namespace_sourceOpportunityId: {
        namespace: EXPECTED_NAMESPACE,
        sourceOpportunityId: firstBrandOpportunity.id,
      },
    },
    include: { opportunity: true },
  });
  const brandUser = demoBrand
    ? await prisma.user.findUnique({
        where: { id: demoBrand.opportunity.brandId },
      })
    : null;
  const loginReady = [demoCreator?.creator.user, brandUser, accounts[0]].every(
    (user) =>
      user?.passwordHash.startsWith('$2') &&
      user.emailVerifiedAt &&
      user.onboardedAt,
  );
  if (!loginReady)
    mismatches.push('one or more demo login accounts are not ready');
  console.log(
    JSON.stringify(
      {
        valid: mismatches.length === 0,
        databaseFingerprint: target.fingerprint,
        counts,
        expected,
        demoAccounts: {
          creator: demoCreator?.creator.user.email,
          brand: brandUser?.email,
          admin: accounts[0]?.email,
        },
        paymentAndNotificationIsolation: {
          transactions: 0,
          webhooks: 0,
          payouts: 0,
          notifications: 0,
        },
        mismatches,
      },
      null,
      2,
    ),
  );
  if (mismatches.length) process.exitCode = 2;
} finally {
  await prisma.$disconnect();
}
