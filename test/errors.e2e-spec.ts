import { bootApp, cleanup, makeUser, TEST_DOMAIN } from './helpers.js';

const SHAPE = { statusCode: expect.any(Number), message: expect.any(String), code: expect.any(String) };

describe('Error shape and rate limiting (e2e)', () => {
  let ctx: Awaited<ReturnType<typeof bootApp>>;

  beforeAll(async () => {
    ctx = await bootApp();
  });
  afterAll(async () => {
    await cleanup(ctx.prisma);
    await ctx.app.close();
  });

  it('wrong password: friendly message and INVALID_CREDENTIALS', async () => {
    const r = await ctx.http.post('/auth/login').send({ email: `nobody${TEST_DOMAIN}`, password: 'wrongpass1' }).expect(401);
    expect(r.body).toMatchObject({ ...SHAPE, code: 'INVALID_CREDENTIALS', message: 'Incorrect email or password.' });
  });

  it('validation: friendly message plus per-field errors', async () => {
    const r = await ctx.http.post('/auth/register').send({ email: 'not-an-email', password: 'x', role: 'BRAND' }).expect(400);
    expect(r.body).toMatchObject({ ...SHAPE, code: 'VALIDATION_ERROR', message: 'Please check your details and try again.' });
    expect(r.body.errors.map((e: { path: string }) => e.path).sort()).toEqual(['email', 'password']);
  });

  it('missing token, unknown route and malformed JSON never show framework text', async () => {
    const noAuth = await ctx.http.get('/auth/me').expect(401);
    expect(noAuth.body).toMatchObject({ ...SHAPE, code: 'UNAUTHENTICATED', message: 'Please sign in to continue.' });

    const user = await makeUser(ctx.http, 'CREATOR');
    const missing = await ctx.http.get('/no/such/route').set(user.auth).expect(404);
    expect(missing.body).toMatchObject({ ...SHAPE, code: 'NOT_FOUND' });
    expect(missing.body.message).not.toMatch(/Cannot GET/);

    const bad = await ctx.http.post('/auth/login').set('content-type', 'application/json').send('{oops').expect(400);
    expect(bad.body).toMatchObject(SHAPE);
  });

  it('a malformed id is a friendly 400, not raw pipe text', async () => {
    const user = await makeUser(ctx.http, 'CREATOR');
    const r = await ctx.http.get('/creators/not-a-uuid').set(user.auth).expect(400);
    expect(r.body).toMatchObject({ ...SHAPE, code: 'VALIDATION_ERROR' });
    expect(r.body.message).not.toMatch(/uuid|Validation failed/);
  });

  it('role and stage errors carry codes and plain wording', async () => {
    const creator = await makeUser(ctx.http, 'CREATOR');
    const wrongRole = await ctx.http.post('/opportunities').set(creator.auth).send({}).expect(403);
    expect(wrongRole.body).toMatchObject({ ...SHAPE, code: 'WRONG_ROLE', message: "You don't have access to this." });
  });

  it('reused refresh token says the session expired, not "reused"', async () => {
    const email = `reuse_${Date.now()}${TEST_DOMAIN}`;
    const reg = await ctx.http.post('/auth/register').send({ email, password: 'password123', role: 'BRAND' }).expect(201);
    await ctx.http.post('/auth/refresh').send({ refreshToken: reg.body.refreshToken }).expect(200);
    const again = await ctx.http.post('/auth/refresh').send({ refreshToken: reg.body.refreshToken }).expect(401);
    expect(again.body).toMatchObject({ ...SHAPE, code: 'SESSION_EXPIRED' });
    expect(again.body.message).not.toMatch(/reused|revoked/i);
  });

  it('rate limit: the 21st login in a minute is 429 RATE_LIMITED', async () => {
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development'; // the limiter is skipped under NODE_ENV=test
    try {
      let last = 0;
      let body: Record<string, unknown> = {};
      for (let i = 0; i < 21; i++) {
        const r = await ctx.http.post('/auth/login').send({ email: `limit${TEST_DOMAIN}`, password: 'wrongpass1' });
        last = r.status;
        body = r.body;
      }
      expect(last).toBe(429);
      expect(body).toMatchObject({ ...SHAPE, code: 'RATE_LIMITED', message: 'Too many attempts. Please wait a minute and try again.' });
    } finally {
      process.env.NODE_ENV = before;
    }
  });
});
