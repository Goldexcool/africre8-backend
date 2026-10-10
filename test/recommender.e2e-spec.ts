import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, cleanup, makeUser } from './helpers.js';

/**
 * The recommender is the default ranking for a brand hiring for a brief: app creators and app briefs get ML features
 * as they are saved, and /discover ranks with them. Needs the ML service (ML_SERVICE_URL, default 127.0.0.1:8001);
 * skipped when it is not running.
 */
const ML = process.env.ML_SERVICE_URL ?? 'http://127.0.0.1:8001';
const mlUp = await fetch(`${ML}/ready`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok).catch(() => false);

const brief = (deliverables: string[], title = 'Food launch') => ({
  title,
  brief: 'Short videos showing our new jollof spice in a home kitchen.',
  category: 'Food & Culinary',
  budgetNgn: 300000,
  deadlineDays: 14,
  deliverables,
});

describe.skipIf(!mlUp)('Recommender by default (e2e, live ML service)', () => {
  let ctx: Awaited<ReturnType<typeof bootApp>>;
  beforeAll(async () => {
    ctx = await bootApp();
  });
  afterAll(async () => {
    await cleanup(ctx.prisma);
    await ctx.app.close();
  });

  it('a new creator gets ML features on save; a new brief is ranked by the recommender with match and credibility', async () => {
    const { http, prisma } = ctx;
    const creator = await makeUser(http, 'CREATOR');
    await http.put('/profiles/creator').set(creator.auth).send({ displayName: 'Chef Ada', category: 'Food & Culinary', niches: ['Food & Culinary'], bio: 'Home cooking videos', priceFromNgn: 120000, socials: [{ platform: 'tiktok', handle: '@chefada', followers: 40000, engagementRate: 6 }] }).expect(200);
    const ml = await prisma.creatorMlProfile.findUnique({ where: { creatorId: creator.id }, include: { deliverableCapabilities: true, commercialRates: true } });
    expect(ml).toMatchObject({ namespace: 'africre8-operational-v1', synthetic: false });
    expect(ml!.deliverableCapabilities.map((c) => c.platform)).toEqual(['tiktok']);
    expect(ml!.commercialRates).toHaveLength(1);

    // dropping a platform removes it from the ML features too (replaced, not merged)
    await http.put('/profiles/creator').set(creator.auth).send({ displayName: 'Chef Ada', socials: [{ platform: 'instagram', handle: '@chefada', followers: 40000, engagementRate: 6 }] }).expect(200);
    const after = await prisma.creatorMlProfile.findUnique({ where: { creatorId: creator.id }, include: { deliverableCapabilities: true } });
    expect(after!.deliverableCapabilities.map((c) => c.platform)).toEqual(['instagram']);
    await http.put('/profiles/creator').set(creator.auth).send({ displayName: 'Chef Ada', socials: [{ platform: 'tiktok', handle: '@chefada', followers: 40000, engagementRate: 6 }] }).expect(200);

    const brand = await makeUser(http, 'BRAND');
    // "Tag" and "Use" lines are notes; the TikTok line is the deliverable
    const o = await http.post('/opportunities').set(brand.auth).send(brief(['1 TikTok video, 30-60s', 'Tag @spiceco', 'Use #JollofNight'])).expect(201);
    const d = await http.get(`/discover?opportunityId=${o.body.id}&limit=50`).set(brand.auth).expect(200);
    expect(d.body.ranking).toMatchObject({ source: 'recommender', model: { mode: 'structured' } });
    const card = d.body.items.find((c: { id: string }) => c.id === creator.id);
    expect(card.match).toMatchObject({ rank: expect.any(Number), score: expect.any(Number), summary: expect.any(String), matched: expect.any(Array) });
    expect(card.match.credibility).toMatchObject({ status: expect.any(String), tier: expect.any(String) });
    // recommended creators come first, in rank order
    const ranks = d.body.items.filter((c: { match: unknown }) => c.match).map((c: { match: { rank: number } }) => c.match.rank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    const matched = d.body.items.map((c: { match: unknown }) => !!c.match);
    expect(matched).toEqual([...matched].sort((a: boolean, b: boolean) => Number(b) - Number(a))); // no unranked creator before a ranked one

    // credibility for one creator, as a brand sees it on the profile
    const cred = await http.get(`/creators/${creator.id}/credibility`).set(brand.auth).expect(200);
    expect(cred.body).toMatchObject({ creator_id: creator.id, evidence_tier: expect.any(String) });
  });

  it('a brief that names no platform falls back to the usual order and says how to fix it', async () => {
    const { http } = ctx;
    const brand = await makeUser(http, 'BRAND');
    const o = await http.post('/opportunities').set(brand.auth).send(brief(['Two short videos', 'Tag @spiceco'], 'Vague brief')).expect(201);
    const d = await http.get(`/discover?opportunityId=${o.body.id}`).set(brand.auth).expect(200);
    expect(d.body.ranking).toMatchObject({ source: 'default', note: expect.stringMatching(/Name the platform/) });
    expect(d.body.items.every((c: { match: unknown }) => c.match === null)).toBe(true);
    await http.post(`/opportunities/${o.body.id}/recommendations`).set(brand.auth).send({}).expect(409);
  });

  it('another brand cannot rank someone else’s brief', async () => {
    const { http } = ctx;
    const owner = await makeUser(http, 'BRAND');
    const other = await makeUser(http, 'BRAND');
    const o = await http.post('/opportunities').set(owner.auth).send(brief(['1 TikTok video'])).expect(201);
    await http.get(`/discover?opportunityId=${o.body.id}`).set(other.auth).expect(404);
  });
});
