import { bootApp, cleanup, makeUser } from './helpers.js';

describe('Discovery + matching (e2e)', () => {
  let ctx: Awaited<ReturnType<typeof bootApp>>;

  beforeAll(async () => {
    ctx = await bootApp();
  });

  afterAll(async () => {
    await cleanup(ctx.prisma);
    await ctx.app.close();
  });

  it('swipe → interest → accept → match → chat, members only', async () => {
    const { http } = ctx;
    const brand = await makeUser(http, 'BRAND');
    const creator = await makeUser(http, 'CREATOR');
    const outsider = await makeUser(http, 'BRAND');

    const disc = await http.get('/discover?category=Fashion%20%26%20Lifestyle&limit=50').set(brand.auth).expect(200);
    expect(disc.body.items.length).toBeGreaterThan(0);
    await http.get('/discover').set(creator.auth).expect(403); // creators don't swipe on creators

    const swipe = await http.post('/swipes').set(brand.auth).send({ creatorId: creator.id, direction: 'LIKE' }).expect(201);
    const again = await http.post('/swipes').set(brand.auth).send({ creatorId: creator.id, direction: 'LIKE' }).expect(201);
    expect(again.body.interest.id).toBe(swipe.body.interest.id); // no duplicate interest

    const after = await http.get('/discover?limit=50').set(brand.auth).expect(200);
    expect(after.body.items.find((c: { id: string }) => c.id === creator.id)).toBeUndefined();

    const inbox = await http.get('/interests').set(creator.auth).expect(200);
    expect(inbox.body[0].brand.businessName).toBe('Test Brand');
    const notes = await http.get('/notifications').set(creator.auth).expect(200);
    expect(notes.body[0].kind).toBe('interest');

    const res = await http.post(`/interests/${swipe.body.interest.id}/respond`).set(creator.auth).send({ accept: true }).expect(201);
    await http.post(`/interests/${swipe.body.interest.id}/respond`).set(creator.auth).send({ accept: true }).expect(409);
    await http.delete(`/swipes/${creator.id}`).set(brand.auth).expect(409); // can't undo after answer

    const matches = await http.get('/matches').set(brand.auth).expect(200);
    const convId = matches.body[0].conversationId;
    expect(convId).toBe(res.body.match.conversation.id);

    await http.post(`/conversations/${convId}/messages`).set(brand.auth).send({ text: 'Hi Amara!' }).expect(201);
    const msgs = await http.get(`/conversations/${convId}/messages`).set(creator.auth).expect(200);
    expect(msgs.body[0].text).toBe('Hi Amara!');
    await http.get(`/conversations/${convId}/messages`).set(outsider.auth).expect(403);
  });

  it('pass hides creator; undo restores while pending', async () => {
    const { http } = ctx;
    const brand = await makeUser(http, 'BRAND');
    const creator = await makeUser(http, 'CREATOR');
    await http.post('/swipes').set(brand.auth).send({ creatorId: creator.id, direction: 'LIKE' }).expect(201);
    await http.delete(`/swipes/${creator.id}`).set(brand.auth).expect(204);
    const inbox = await http.get('/interests').set(creator.auth).expect(200);
    expect(inbox.body).toHaveLength(0);
  });
});
