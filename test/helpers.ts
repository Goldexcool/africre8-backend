import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

export const TEST_DOMAIN = '@test.africre8.dev';

export async function bootApp(configure?: (app: INestApplication) => void) {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = mod.createNestApplication({ rawBody: true });
  configure?.(app);
  await app.init();
  return { app, http: request(app.getHttpServer()), prisma: app.get(PrismaService) };
}

let n = 0;
/** Registers and onboards a throwaway user; returns its id and auth header. */
export async function makeUser(http: ReturnType<typeof request>, role: 'BRAND' | 'CREATOR') {
  const email = `${role.toLowerCase()}_${Date.now()}_${n++}${TEST_DOMAIN}`;
  const reg = await http.post('/auth/register').send({ email, password: 'password123', role }).expect(201);
  const auth = { Authorization: `Bearer ${reg.body.accessToken}` };
  if (role === 'BRAND') {
    await http.put('/profiles/brand').set(auth).send({ businessName: 'Test Brand', industry: 'Fashion' }).expect(200);
  } else {
    await http
      .put('/profiles/creator')
      .set(auth)
      .send({
        displayName: 'Test Creator',
        category: 'Fashion & Lifestyle',
        location: 'Lagos, Nigeria',
        priceFromNgn: 150000,
        socials: [{ platform: 'tiktok', handle: '@testcreator', followers: 5000, engagementRate: 5 }],
      })
      .expect(200);
  }
  return { id: reg.body.user.id as string, auth };
}

/** Removes everything created by test users so the shared DB stays clean. */
export async function cleanup(prisma: PrismaService) {
  const users = await prisma.user.findMany({ where: { email: { endsWith: TEST_DOMAIN } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (!ids.length) return;
  const campaigns = await prisma.campaign.findMany({ where: { OR: [{ brandId: { in: ids } }, { creatorId: { in: ids } }] }, select: { id: true } });
  const cids = campaigns.map((c) => c.id);
  await prisma.$transaction([
    prisma.transaction.deleteMany({ where: { campaignId: { in: cids } } }),
    prisma.dispute.deleteMany({ where: { campaignId: { in: cids } } }),
    prisma.campaign.deleteMany({ where: { id: { in: cids } } }),
    prisma.match.deleteMany({ where: { OR: [{ brandId: { in: ids } }, { creatorId: { in: ids } }] } }),
    prisma.interest.deleteMany({ where: { OR: [{ brandId: { in: ids } }, { creatorId: { in: ids } }] } }),
    prisma.swipe.deleteMany({ where: { OR: [{ brandId: { in: ids } }, { creatorId: { in: ids } }] } }),
    prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }),
    prisma.user.deleteMany({ where: { id: { in: ids } } }),
  ]);
}

/** Brand + creator that have matched; returns both users and the match/conversation ids. */
export async function makeMatch(http: ReturnType<typeof request>) {
  const brand = await makeUser(http, 'BRAND');
  const creator = await makeUser(http, 'CREATOR');
  const swipe = await http.post('/swipes').set(brand.auth).send({ creatorId: creator.id, direction: 'LIKE' }).expect(201);
  const res = await http.post(`/interests/${swipe.body.interest.id}/respond`).set(creator.auth).send({ accept: true }).expect(201);
  return { brand, creator, matchId: res.body.match.id as string, conversationId: res.body.match.conversation.id as string };
}

export const sampleTerms = (overrides: Record<string, unknown> = {}) => ({
  title: 'Red Handbag Launch',
  brief: 'A TikTok video featuring our red Adire handbag in an everyday Lagos outfit.',
  amountNgn: 200000,
  deadline: new Date(Date.now() + 7 * 864e5).toISOString(),
  requirements: [{ title: '1 TikTok video', platform: 'tiktok', hashtags: ['AdireAtelier'], mentions: ['adireatelier'], contentBrief: 'Red handbag clearly featured' }],
  ...overrides,
});
