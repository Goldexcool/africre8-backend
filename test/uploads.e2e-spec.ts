import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { bootApp, cleanup, makeUser } from './helpers.js';

const sign = (kind: string, contentType = 'image/jpeg', size = 120_000) => ({ kind, contentType, size });

describe('Uploads (e2e)', () => {
  let ctx: Awaited<ReturnType<typeof bootApp>>;
  beforeAll(async () => {
    ctx = await bootApp();
  });
  afterAll(async () => {
    await cleanup(ctx.prisma);
    await ctx.app.close();
  });

  it('signs a short-lived PUT for a creator photo, with a stable public URL', async () => {
    const creator = await makeUser(ctx.http, 'CREATOR');
    const r = await ctx.http.post('/uploads/sign').set(creator.auth).send(sign('avatar')).expect(201);
    expect(r.body.method).toBe('PUT');
    expect(r.body.key).toMatch(new RegExp(`^africre8/avatar/${creator.id}/[0-9a-f-]{36}\\.jpg$`));
    expect(r.body.publicUrl).toMatch(new RegExp(`/media/${r.body.key}$`));
    expect(r.body.headers).toEqual({ 'Content-Type': 'image/jpeg' });
    const url = new URL(r.body.uploadUrl);
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toMatch(/content-length/); // size is part of the signature
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toMatch(/content-type/);
  });

  it('refuses types, sizes and roles it should', async () => {
    const creator = await makeUser(ctx.http, 'CREATOR');
    const brand = await makeUser(ctx.http, 'BRAND');
    const gif = await ctx.http.post('/uploads/sign').set(creator.auth).send(sign('avatar', 'image/gif')).expect(400);
    expect(gif.body.code).toBe('VALIDATION_ERROR');
    expect(gif.body.errors[0].message).toMatch(/JPEG, PNG or WebP/);
    const big = await ctx.http.post('/uploads/sign').set(creator.auth).send(sign('portfolio', 'image/png', 9 * 1024 * 1024)).expect(400);
    expect(big.body.errors[0].message).toMatch(/8 MB/);
    await ctx.http.post('/uploads/sign').set(creator.auth).send(sign('avatar', 'image/png', 0)).expect(400);
    await ctx.http.post('/uploads/sign').set(brand.auth).send(sign('avatar')).expect(403);
    await ctx.http.post('/uploads/sign').set(creator.auth).send(sign('logo')).expect(403);
    await ctx.http.post('/uploads/sign').set(brand.auth).send(sign('logo', 'image/webp')).expect(201);
    await ctx.http.post('/uploads/sign').set(brand.auth).send(sign('evidence')).expect(201);
    await ctx.http.post('/uploads/sign').set(creator.auth).send(sign('evidence')).expect(201);
    await ctx.http.post('/uploads/sign').send(sign('avatar')).expect(401);
  });

  it('caps how many URLs one person can request', async () => {
    const creator = await makeUser(ctx.http, 'CREATOR');
    for (let i = 0; i < 40; i++) await ctx.http.post('/uploads/sign').set(creator.auth).send(sign('portfolio', 'image/webp', 1000)).expect(201);
    const over = await ctx.http.post('/uploads/sign').set(creator.auth).send(sign('portfolio', 'image/webp', 1000)).expect(429);
    expect(over.body.code).toBe('RATE_LIMITED');
  });

  it('only serves images under its own prefix', async () => {
    await ctx.http.get('/media/other-project/secret.jpg').expect(404);
    await ctx.http.get('/media/africre8/../expo/secret.jpg').expect(404);
    await ctx.http.get('/media/africre8/avatar/nobody/missing.jpg').expect(404); // not in storage
  });

  // Opt-in: writes one tiny object to the shared bucket under africre8/, reads it back through /media, then deletes it.
  const live = process.env.R2_LIVE_TEST === '1' ? it : it.skip;
  live('LIVE: upload through the signed URL and read it back through /media; wrong size or type is refused', async () => {
    const creator = await makeUser(ctx.http, 'CREATOR');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const s = await ctx.http.post('/uploads/sign').set(creator.auth).send(sign('avatar', 'image/png', png.length)).expect(201);
    try {
      const bad = await fetch(s.body.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: Buffer.concat([png, Buffer.from('x')]) });
      expect(bad.status).toBeGreaterThanOrEqual(400); // size mismatch
      const wrongType = await fetch(s.body.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'text/html' }, body: png });
      expect(wrongType.status).toBeGreaterThanOrEqual(400); // type mismatch
      const ok = await fetch(s.body.uploadUrl, { method: 'PUT', headers: s.body.headers, body: png });
      expect(ok.status).toBe(200);
      const res = await ctx.http.get(new URL(s.body.publicUrl).pathname).expect(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['cache-control']).toMatch(/immutable/);
      expect(Buffer.from(res.body).equals(png)).toBe(true);
    } finally {
      const c = new S3Client({ region: 'auto', endpoint: process.env.R2_ENDPOINT, credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! } });
      await c.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: s.body.key }));
    }
  });
});
