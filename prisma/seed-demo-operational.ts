import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';
import {
  PrismaClient,
  type CampaignStatus,
  type Platform,
} from '../src/generated/prisma/client.js';
import {
  EXPECTED_COUNTS,
  EXPECTED_NAMESPACE,
  assertApprovedDemoTarget,
  loadAndValidateDataset,
} from './demo-import/core.js';
import {
  campaignStatus,
  deterministicUuid,
  eventOf,
  groupJourneys,
  interestStatus,
  normalizedKobo,
} from './demo-operational/core.js';

const arg = (name: string) =>
  process.argv
    .find((value) => value.startsWith(`${name}=`))
    ?.slice(name.length + 1);
const write = process.argv.includes('--write');
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
  write,
});

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});
const adminId = deterministicUuid('admin');

function requiredPassword(
  name: 'DEMO_BRAND_PASSWORD' | 'DEMO_CREATOR_PASSWORD' | 'DEMO_ADMIN_PASSWORD',
) {
  const value = process.env[name];
  if (!value || value.length < 12)
    throw new Error(`${name} must contain at least 12 characters`);
  return value;
}

try {
  const [creators, opportunities, eventCount, users] = await Promise.all([
    prisma.creatorMlProfile.findMany({
      where: { namespace: EXPECTED_NAMESPACE, synthetic: true },
      select: {
        sourceCreatorId: true,
        creatorId: true,
        creator: { select: { user: { select: { email: true } } } },
      },
    }),
    prisma.opportunityMlProfile.findMany({
      where: { namespace: EXPECTED_NAMESPACE, synthetic: true },
      select: {
        sourceOpportunityId: true,
        opportunityId: true,
        opportunity: { select: { brandId: true, title: true, brief: true } },
      },
    }),
    prisma.demoMlEvidenceEvent.count({
      where: { namespace: EXPECTED_NAMESPACE, synthetic: true },
    }),
    prisma.user.findMany({ select: { id: true } }),
  ]);
  if (
    creators.length !== EXPECTED_COUNTS.creators ||
    opportunities.length !== EXPECTED_COUNTS.opportunities ||
    eventCount !== EXPECTED_COUNTS.interactions
  ) {
    throw new Error(
      'complete demo-v2 ML import is required before operational seeding',
    );
  }
  const creatorBySource = new Map(
    creators.map((row) => [row.sourceCreatorId, row]),
  );
  const opportunityBySource = new Map(
    opportunities.map((row) => [row.sourceOpportunityId, row]),
  );
  const managedUsers = new Set([
    ...creators.map((row) => row.creatorId),
    ...opportunities.map((row) => row.opportunity.brandId),
    adminId,
  ]);
  const unmanaged = users.filter((row) => !managedUsers.has(row.id));
  if (unmanaged.length)
    throw new Error(
      `operational seed refused: ${unmanaged.length} user(s) are outside the synthetic demo dataset`,
    );

  const journeys = groupJourneys(dataset.interactions);
  const interestPlans = new Map<string, any>();
  const matchPlans = new Map<string, any>();
  const campaignPlans: any[] = [];
  for (const [journeyId, rows] of journeys) {
    const root = rows[0];
    const creator = creatorBySource.get(root.creator_id);
    const opportunity = opportunityBySource.get(root.opportunity_id);
    if (!creator || !opportunity)
      throw new Error(
        `journey ${journeyId} has no imported operational mapping`,
      );
    const direction = root.details.direction;
    const interestKey = `${opportunity.opportunity.brandId}:${creator.creatorId}:${opportunity.opportunityId}`;
    const interest = {
      id: deterministicUuid(`interest:${interestKey}`),
      brandId: opportunity.opportunity.brandId,
      creatorId: creator.creatorId,
      senderId:
        direction === 'creator_application'
          ? creator.creatorId
          : opportunity.opportunity.brandId,
      opportunityId: opportunity.opportunityId,
      scopeKey: opportunity.opportunityId,
      message:
        direction === 'creator_application'
          ? 'Synthetic demo application generated from versioned evidence.'
          : 'Synthetic demo invitation generated from versioned evidence.',
      status: interestStatus(rows),
      createdAt: new Date(`${root.occurred_at}T00:00:00.000Z`),
      expiresAt: new Date(
        new Date(`${root.occurred_at}T00:00:00.000Z`).getTime() + 14 * 864e5,
      ),
    };
    const existingInterest = interestPlans.get(interestKey);
    const priority = { EXPIRED: 0, DECLINED: 1, ACCEPTED: 2 } as const;
    if (
      !existingInterest ||
      priority[interest.status] >
        priority[existingInterest.status as keyof typeof priority]
    )
      interestPlans.set(interestKey, interest);
    if (eventOf(rows, 'match')) {
      const matchKey = `${opportunity.opportunity.brandId}:${creator.creatorId}`;
      if (!matchPlans.has(matchKey))
        matchPlans.set(matchKey, {
          id: deterministicUuid(`match:${matchKey}`),
          brandId: opportunity.opportunity.brandId,
          creatorId: creator.creatorId,
          opportunityId: opportunity.opportunityId,
          createdAt: new Date(
            `${eventOf(rows, 'match')!.occurred_at}T00:00:00.000Z`,
          ),
        });
    }
    const contract = eventOf(rows, 'contract');
    if (!contract) continue;
    const matchKey = `${opportunity.opportunity.brandId}:${creator.creatorId}`;
    const match = matchPlans.get(matchKey);
    if (!match)
      throw new Error(
        `contract ${contract.contract_id} has no accepted collaboration`,
      );
    campaignPlans.push({
      id: deterministicUuid(`campaign:${contract.contract_id}`),
      sourceContractId: contract.contract_id,
      matchId: match.id,
      brandId: opportunity.opportunity.brandId,
      creatorId: creator.creatorId,
      title: opportunity.opportunity.title,
      brief: `${opportunity.opportunity.brief}\n\nSynthetic demonstration contract; no real commercial activity or payment.`,
      amountKobo: normalizedKobo(contract.details.agreed_fee.normalized_usd),
      feeKobo: 0,
      currency: 'NGN',
      deadline: new Date(`${contract.details.deadline}T00:00:00.000Z`),
      revisionLimit: 2,
      usageRights: JSON.stringify(contract.details.usage_rights),
      status: campaignStatus(rows) as CampaignStatus,
      termsVersion: 1,
      brandAcceptedAt: new Date(`${contract.occurred_at}T00:00:00.000Z`),
      creatorAcceptedAt: new Date(`${contract.occurred_at}T00:00:00.000Z`),
      completedAt: eventOf(rows, 'completion')
        ? new Date(`${eventOf(rows, 'completion')!.occurred_at}T00:00:00.000Z`)
        : null,
      createdAt: new Date(`${contract.occurred_at}T00:00:00.000Z`),
      requirements: contract.details.deliverables.map(
        (item: any, index: number) => ({
          id: deterministicUuid(`requirement:${contract.contract_id}:${index}`),
          position: index,
          title: `${item.quantity} × ${item.format.replaceAll('_', ' ')}`,
          platform: item.platform as Platform,
          hashtags: [],
          mentions: [],
          contentBrief:
            'Synthetic demo deliverable derived from the versioned campaign contract.',
        }),
      ),
    });
  }
  if (journeys.size !== 430 || campaignPlans.length !== 360)
    throw new Error('unexpected synthetic journey or contract count');

  const demoCreator = creatorBySource.get(dataset.creators[0].id)!;
  const demoBrand = opportunityBySource.get(
    dataset.opportunities.find((row) => row.brand_id === dataset.brands[0].id)!
      .id,
  )!.opportunity;
  const report = {
    mode: write ? 'write' : 'dry-run',
    databaseFingerprint: target.fingerprint,
    counts: {
      users: managedUsers.size,
      interests: interestPlans.size,
      matches: matchPlans.size,
      campaigns: campaignPlans.length,
      requirements: campaignPlans.reduce(
        (sum, row) => sum + row.requirements.length,
        0,
      ),
    },
    demoAccounts: {
      creator: demoCreator.creator.user.email,
      brand: (
        await prisma.user.findUniqueOrThrow({
          where: { id: demoBrand.brandId },
          select: { email: true },
        })
      ).email,
      admin: 'admin.demo@africre8.invalid',
    },
    sideEffects: {
      transactions: 0,
      payoutDestinations: 0,
      webhooks: 0,
      notifications: 0,
      outboundEmail: false,
    },
  };

  if (write) {
    const [brandHash, creatorHash, adminHash] = await Promise.all([
      bcrypt.hash(requiredPassword('DEMO_BRAND_PASSWORD'), 10),
      bcrypt.hash(requiredPassword('DEMO_CREATOR_PASSWORD'), 10),
      bcrypt.hash(requiredPassword('DEMO_ADMIN_PASSWORD'), 10),
    ]);
    await prisma.$transaction(
      async (tx) => {
        await tx.user.update({
          where: { id: demoBrand.brandId },
          data: {
            passwordHash: brandHash,
            status: 'ACTIVE',
            verificationStatus: 'VERIFIED',
            emailVerifiedAt: new Date(),
            onboardedAt: new Date(),
          },
        });
        await tx.user.update({
          where: { id: demoCreator.creatorId },
          data: {
            passwordHash: creatorHash,
            status: 'ACTIVE',
            verificationStatus: 'VERIFIED',
            emailVerifiedAt: new Date(),
            onboardedAt: new Date(),
          },
        });
        await tx.user.upsert({
          where: { id: adminId },
          create: {
            id: adminId,
            email: 'admin.demo@africre8.invalid',
            passwordHash: adminHash,
            role: 'ADMIN',
            status: 'ACTIVE',
            verificationStatus: 'VERIFIED',
            emailVerifiedAt: new Date(),
            onboardedAt: new Date(),
          },
          update: {
            passwordHash: adminHash,
            status: 'ACTIVE',
            verificationStatus: 'VERIFIED',
            emailVerifiedAt: new Date(),
            onboardedAt: new Date(),
          },
        });
        for (const item of interestPlans.values())
          await tx.interest.upsert({
            where: {
              brandId_creatorId_scopeKey: {
                brandId: item.brandId,
                creatorId: item.creatorId,
                scopeKey: item.scopeKey,
              },
            },
            create: item,
            update: {
              senderId: item.senderId,
              opportunityId: item.opportunityId,
              message: item.message,
              status: item.status,
              expiresAt: item.expiresAt,
            },
          });
        for (const item of matchPlans.values()) {
          const match = await tx.match.upsert({
            where: {
              brandId_creatorId: {
                brandId: item.brandId,
                creatorId: item.creatorId,
              },
            },
            create: item,
            update: { opportunityId: item.opportunityId },
          });
          await tx.conversation.upsert({
            where: { matchId: match.id },
            create: {
              id: deterministicUuid(`conversation:${match.id}`),
              matchId: match.id,
            },
            update: {},
          });
        }
        for (const item of campaignPlans) {
          const {
            requirements,
            sourceContractId: _sourceContractId,
            ...campaign
          } = item;
          await tx.campaign.upsert({
            where: { id: campaign.id },
            create: campaign,
            update: {
              title: campaign.title,
              brief: campaign.brief,
              amountKobo: campaign.amountKobo,
              deadline: campaign.deadline,
              usageRights: campaign.usageRights,
              status: campaign.status,
              completedAt: campaign.completedAt,
            },
          });
          await tx.deliverableRequirement.deleteMany({
            where: { campaignId: campaign.id },
          });
          await tx.deliverableRequirement.createMany({
            data: requirements.map((row: any) => ({
              ...row,
              campaignId: campaign.id,
            })),
          });
        }
      },
      { maxWait: 10_000, timeout: 300_000 },
    );
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await prisma.$disconnect();
}
