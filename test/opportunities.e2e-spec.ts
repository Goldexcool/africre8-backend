import { bootApp, cleanup, makeUser } from './helpers.js';

const brief = (o: Record<string, unknown> = {}) => ({
  title: 'Adire Handbag Launch',
  brief: 'Show our red adire handbag in an everyday Lagos outfit on TikTok.',
  category: 'Fashion & Lifestyle',
  budgetNgn: 200000,
  deadlineDays: 7,
  deliverables: ['1 TikTok video'],
  ...o,
});

describe('Campaign briefs, invitations, applications (e2e)', () => {
  let ctx: Awaited<ReturnType<typeof bootApp>>;

  beforeAll(async () => {
    ctx = await bootApp();
  });

  afterAll(async () => {
    await cleanup(ctx.prisma);
    await ctx.app.close();
  });

  it('public brief caps applications; private brief is invite-only', async () => {
    const { http } = ctx;
    const brand = await makeUser(http, 'BRAND');
    const a = await makeUser(http, 'CREATOR');
    const b = await makeUser(http, 'CREATOR');

    const pub = await http.post('/opportunities').set(brand.auth).send(brief({ applicationLimit: 1 })).expect(201);
    const priv = await http.post('/opportunities').set(brand.auth).send(brief({ title: 'Private launch', visibility: 'PRIVATE' })).expect(201);

    const feed = await http.get('/opportunities/feed').set(a.auth).expect(200);
    const ids = feed.body.map((o: { id: string }) => o.id);
    expect(ids).toContain(pub.body.id);
    expect(ids).not.toContain(priv.body.id);
    await http.get(`/opportunities/${priv.body.id}`).set(a.auth).expect(404);

    await http.post(`/opportunities/${pub.body.id}/apply`).set(a.auth).send({ message: 'I style handbags for 200k women in Lagos.' }).expect(201);
    await http.post(`/opportunities/${pub.body.id}/apply`).set(a.auth).send({ message: 'Applying a second time here.' }).expect(409);
    await http.post(`/opportunities/${pub.body.id}/apply`).set(b.auth).send({ message: 'I would love to do this one too.' }).expect(409); // limit 1 reached
    await http.post(`/opportunities/${priv.body.id}/apply`).set(b.auth).send({ message: 'Can I apply to this private one?' }).expect(409);
    const feedB = await http.get('/opportunities/feed').set(b.auth).expect(200);
    expect(feedB.body.map((o: { id: string }) => o.id)).not.toContain(pub.body.id); // full

    const mine = await http.get('/opportunities/mine').set(brand.auth).expect(200);
    const pubRow = mine.body.find((o: { id: string }) => o.id === pub.body.id);
    expect(pubRow.applications).toBe(1);
    expect(pubRow.slotsLeft).toBe(0);

    // Brand accepts the application: connection records the brief, the note becomes the first message.
    const inbox = await http.get('/interests').set(brand.auth).expect(200);
    const app = inbox.body.find((i: { opportunityId: string }) => i.opportunityId === pub.body.id);
    expect(app.kind).toBe('application');
    expect(app.direction).toBe('incoming');
    await http.post(`/interests/${app.id}/respond`).set(a.auth).send({ accept: true }).expect(409); // sender can't accept own
    const res = await http.post(`/interests/${app.id}/respond`).set(brand.auth).send({ accept: true }).expect(201);
    const matches = await http.get('/matches').set(brand.auth).expect(200);
    const m = matches.body.find((x: { id: string }) => x.id === res.body.match.id);
    expect(m.opportunity.title).toBe('Adire Handbag Launch');
    expect(m.unread).toBe(1);
    await http.post(`/conversations/${m.conversationId}/read`).set(brand.auth).expect(204);
    const after = await http.get('/matches').set(brand.auth).expect(200);
    expect(after.body.find((x: { id: string }) => x.id === m.id).unread).toBe(0);
  });

  it('stack send invites many creators to one brief with one message; private brief becomes visible to invitees', async () => {
    const { http } = ctx;
    const brand = await makeUser(http, 'BRAND');
    const c1 = await makeUser(http, 'CREATOR');
    const c2 = await makeUser(http, 'CREATOR');
    const priv = await http.post('/opportunities').set(brand.auth).send(brief({ title: 'VIP drop', visibility: 'PRIVATE' })).expect(201);

    const sent = await http.post('/interests/bulk').set(brand.auth).send({ creatorIds: [c1.id, c2.id, c1.id], opportunityId: priv.body.id, message: 'Loved your work. Join our VIP drop?' }).expect(201);
    expect(sent.body.sent).toBe(2);

    const inv = await http.get('/interests').set(c1.auth).expect(200);
    expect(inv.body[0].kind).toBe('invitation');
    expect(inv.body[0].opportunity.title).toBe('VIP drop');
    expect(inv.body[0].message).toBe('Loved your work. Join our VIP drop?');
    const feed = await http.get('/opportunities/feed').set(c1.auth).expect(200);
    expect(feed.body.find((o: { id: string }) => o.id === priv.body.id)?.invited).toBe(true);

    // Passing for one brief doesn't hide the creator from the brand's other briefs.
    const other = await http.post('/opportunities').set(brand.auth).send(brief({ title: 'Another brief' })).expect(201);
    await http.post('/swipes').set(brand.auth).send({ creatorId: c2.id, direction: 'PASS', opportunityId: other.body.id }).expect(201);
    const disc = await http.get(`/discover?limit=50&opportunityId=${priv.body.id}`).set(brand.auth).expect(200);
    expect(disc.body.items.find((c: { id: string }) => c.id === c2.id)).toBeUndefined(); // already invited in this scope
  });

  it('creators can turn off invitations', async () => {
    const { http } = ctx;
    const brand = await makeUser(http, 'BRAND');
    const c = await makeUser(http, 'CREATOR');
    let disc = await http.get('/discover?limit=50').set(brand.auth).expect(200);
    expect(disc.body.items.some((x: { id: string }) => x.id === c.id)).toBe(true);
    await http.put('/profiles/creator').set(c.auth).send({ displayName: 'Test Creator', openToInvites: false }).expect(200);
    disc = await http.get('/discover?limit=50').set(brand.auth).expect(200);
    expect(disc.body.items.some((x: { id: string }) => x.id === c.id)).toBe(false);
  });
});
