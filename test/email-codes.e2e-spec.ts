import { MailService } from '../src/mail/mail.service.js';
import { bootApp, cleanup, TEST_DOMAIN } from './helpers.js';

describe('Email codes (e2e)', () => {
  let ctx: Awaited<ReturnType<typeof bootApp>>;
  const lastCode = (to: string) => [...ctx.app.get(MailService).outbox].reverse().find((m) => m.to === to && m.code)?.code;

  beforeAll(async () => {
    ctx = await bootApp();
  });

  afterAll(async () => {
    await cleanup(ctx.prisma);
    await ctx.app.close();
  });

  it('verifies email after signup', async () => {
    const email = `otp_${Date.now()}${TEST_DOMAIN}`;
    const reg = await ctx.http.post('/auth/register').send({ email, password: 'password123', role: 'CREATOR' }).expect(201);
    const auth = { Authorization: `Bearer ${reg.body.accessToken}` };
    const code = lastCode(email)!;
    expect(code).toMatch(/^\d{4}$/);
    const wrong = code === '0000' ? '1111' : '0000';
    await ctx.http.post('/auth/verify-email').set(auth).send({ code: wrong }).expect(400);
    await ctx.http.post('/auth/verify-email').set(auth).send({ code }).expect(204);
    await ctx.http.post('/auth/verify-email').set(auth).send({ code }).expect(400); // single use
    const me = await ctx.http.get('/auth/me').set(auth).expect(200);
    expect(me.body.emailVerifiedAt).toBeTruthy();
  });

  it('forgot → verify code → reset revokes old sessions', async () => {
    const email = `reset_${Date.now()}${TEST_DOMAIN}`;
    const reg = await ctx.http.post('/auth/register').send({ email, password: 'password123', role: 'BRAND' }).expect(201);
    await ctx.http.post('/auth/forgot-password').send({ email: `nobody_${Date.now()}${TEST_DOMAIN}` }).expect(204); // no enumeration
    await ctx.http.post('/auth/forgot-password').send({ email }).expect(204);
    const code = lastCode(email)!;
    await ctx.http.post('/auth/verify-reset-code').send({ email, code }).expect(204);
    await ctx.http.post('/auth/reset-password').send({ email, code, password: 'newpassword456' }).expect(204);
    await ctx.http.post('/auth/reset-password').send({ email, code, password: 'again12345' }).expect(400);
    await ctx.http.post('/auth/refresh').send({ refreshToken: reg.body.refreshToken }).expect(401);
    await ctx.http.post('/auth/login').send({ email, password: 'password123' }).expect(401);
    await ctx.http.post('/auth/login').send({ email, password: 'newpassword456' }).expect(200);
  });
});
