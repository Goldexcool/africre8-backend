import { bootApp } from './helpers.js';

describe('Filter options (e2e)', () => {
  let ctx: Awaited<ReturnType<typeof bootApp>>;
  beforeAll(async () => {
    ctx = await bootApp();
  });
  afterAll(() => ctx.app.close());

  it('is public, lists options, and is cacheable with revalidation', async () => {
    const res = await ctx.http.get('/meta/filters').expect(200); // no token needed
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
    expect(res.headers.etag).toBeTruthy();
    expect(res.body.categories).toEqual(expect.arrayContaining(['Fashion & Lifestyle', 'Beauty']));
    expect([...res.body.categories].sort()).toEqual(res.body.categories); // sorted, no duplicates
    expect(new Set(res.body.categories).size).toBe(res.body.categories.length);
    expect(res.body.platforms).toEqual(['instagram', 'tiktok', 'youtube', 'x', 'facebook']);
    expect(res.body.budgetMaxNgn.every((n: number) => n > 0)).toBe(true);

    await ctx.http.get('/meta/filters').set('If-None-Match', res.headers.etag).expect(304);
  });
});
