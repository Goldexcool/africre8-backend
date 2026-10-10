process.env.PAYMENT_PROVIDER = 'mock';

import { bootApp, cleanup, makeMatch, makeUser, sampleTerms } from './helpers.js';
import { codeAt } from '../src/common/totp.js';

type Who = { id: string; auth: Record<string, string> };

/** P2 to P8: verification review, users and ID checks, money operations, moderation, settings, admin accounts. Mock provider. */
describe('Admin operations (e2e)', () => {
  let ctx: Awaited<ReturnType<typeof bootApp>>;
  let admin: Who;
  let adminEmail: string;

  beforeAll(async () => {
    ctx = await bootApp();
    const u = await makeUser(ctx.http, 'CREATOR');
    const row = await ctx.prisma.user.update({ where: { id: u.id }, data: { role: 'ADMIN' } });
    adminEmail = row.email;
    const login = await ctx.http.post('/auth/login').send({ email: adminEmail, password: 'password123' }).expect(200);
    admin = { id: u.id, auth: { Authorization: `Bearer ${login.body.accessToken}` } };
  });
  afterAll(async () => {
    await cleanup(ctx.prisma);
    await ctx.app.close();
  });

  const get = (path: string, who: Who = admin) => ctx.http.get(path).set(who.auth);
  const post = (path: string, body: object = {}, who: Who = admin) => ctx.http.post(path).set(who.auth).send(body);
  const notes = async (who: Who) => (await get('/notifications', who).expect(200)).body as { title: string; body: string }[];

  async function funded() {
    const { http } = ctx;
    const m = await makeMatch(http);
    const c = await http.post('/campaigns').set(m.brand.auth).send({ matchId: m.matchId, ...sampleTerms() }).expect(201);
    await http.post(`/campaigns/${c.body.id}/accept`).set(m.creator.auth).send({ termsVersion: 1 }).expect(201);
    await http.post(`/campaigns/${c.body.id}/fund`).set(m.brand.auth).send({ method: 'bank_transfer' }).expect(201);
    await http.post(`/campaigns/${c.body.id}/fund/simulate`).set(m.brand.auth).expect(201);
    return { ...m, id: c.body.id as string };
  }

  /** A second admin with a role, signed in. */
  async function adminWith(role: 'SUPER' | 'SUPPORT' | 'FINANCE'): Promise<Who> {
    const email = `admin_${role.toLowerCase()}_${Date.now()}@test.africre8.dev`;
    await post('/admin/admins', { email, password: 'password123456', role }).expect(201);
    const login = await ctx.http.post('/auth/login').send({ email, password: 'password123456' }).expect(200);
    return { id: login.body.user.id, auth: { Authorization: `Bearer ${login.body.accessToken}` } };
  }

  // ---------- P2 verification review ----------

  describe('verification review', () => {
    async function withRun(verdict: 'NEEDS_REVIEW' | 'FAIL' | 'PASS' = 'NEEDS_REVIEW') {
      const c = await funded();
      const camp = await ctx.prisma.campaign.update({ where: { id: c.id }, data: { status: 'under_review' }, include: { requirements: true } });
      const sub = await ctx.prisma.submission.create({ data: { campaignId: c.id, requirementId: camp.requirements[0].id, contentUrl: 'https://www.instagram.com/p/abc123/' } });
      const run = await ctx.prisma.verificationRun.create({ data: { submissionId: sub.id, verdict, summary: 'Could not read the post automatically.', checks: [{ label: 'Hashtag', passed: null, kind: 'rule' }], finishedAt: new Date() } });
      return { ...c, run };
    }

    it('lists runs that need a person, and shows the detail with the brief', async () => {
      const { run, id } = await withRun();
      const list = await get('/admin/verifications?view=review&pageSize=100').expect(200);
      expect(list.body.items.some((r: { id: string }) => r.id === run.id)).toBe(true);
      expect(list.body.items[0]).not.toHaveProperty('evidence'); // frames and transcripts stay out of the list
      const d = await get(`/admin/verifications/${run.id}`).expect(200);
      expect(d.body.campaign.id).toBe(id);
      expect(d.body.submission.contentUrl).toContain('instagram.com');
      expect(d.body.run.reviewDecision).toBeNull();
    });

    it('records a decision once, tells both sides, and leaves the campaign where it was', async () => {
      const { brand, creator, run, id } = await withRun('FAIL');
      await post(`/admin/verifications/${run.id}/decision`, { decision: 'accept', note: 'no' }).expect(400);
      await post(`/admin/verifications/${run.id}/decision`, { decision: 'accept', note: 'Checked by hand: the bag is clearly shown.' }, brand).expect(403);
      const ok = await post(`/admin/verifications/${run.id}/decision`, { decision: 'accept', note: 'Checked by hand: the bag is clearly shown.' }).expect(201);
      expect(ok.body.run.reviewDecision).toBe('accept');
      await post(`/admin/verifications/${run.id}/decision`, { decision: 'reject', note: 'Changed my mind later.' }).expect(409);
      expect((await ctx.prisma.campaign.findUniqueOrThrow({ where: { id } })).status).toBe('under_review'); // record only
      for (const who of [brand, creator]) expect((await notes(who)).some((n) => n.title === 'Post reviewed by AfiCre8')).toBe(true);
      const mine = await get(`/campaigns/${id}`, brand).expect(200);
      expect(mine.body.submissions[0].verifications[0].reviewDecision).toBe('accept');
      const decided = await get('/admin/verifications?view=decided&pageSize=100').expect(200);
      expect(decided.body.items.some((r: { id: string }) => r.id === run.id)).toBe(true);
    });

    it('an unfinished check cannot be decided', async () => {
      const { run } = await withRun();
      await ctx.prisma.verificationRun.update({ where: { id: run.id }, data: { finishedAt: null } });
      await post(`/admin/verifications/${run.id}/decision`, { decision: 'accept', note: 'Looks fine to me.' }).expect(409);
    });
  });

  // ---------- P4 users and KYC ----------

  describe('users and identity', () => {
    it('searches, filters and pages users; the detail shows campaigns, sessions and notes', async () => {
      const u = await makeUser(ctx.http, 'BRAND');
      const email = (await ctx.prisma.user.findUniqueOrThrow({ where: { id: u.id } })).email;
      const found = await get(`/admin/users?q=${encodeURIComponent(email.split('@')[0])}&role=BRAND`).expect(200);
      expect(found.body.items.map((x: { id: string }) => x.id)).toEqual([u.id]);
      expect(found.body.items[0]).not.toHaveProperty('passwordHash');
      expect(found.body.items[0]).not.toHaveProperty('totpSecret');
      expect((await get('/admin/users?status=SUSPENDED&pageSize=1').expect(200)).body.pageSize).toBe(1);
      const d = await get(`/admin/users/${u.id}`).expect(200);
      expect(d.body.user.id).toBe(u.id);
      expect(d.body.sessions.length).toBeGreaterThan(0);
      await post(`/admin/users/${u.id}/notes`, { note: 'Called the brand, all fine.' }).expect(201);
      expect((await get(`/admin/users/${u.id}`).expect(200)).body.notes).toHaveLength(1);
      await get(`/admin/users?role=NOPE`).expect(400);
    });

    it('suspending needs a reason, signs the person out, and shows the reason when they try to sign in', async () => {
      const u = await makeUser(ctx.http, 'CREATOR');
      const email = (await ctx.prisma.user.findUniqueOrThrow({ where: { id: u.id } })).email;
      await post(`/admin/users/${u.id}/suspend`, {}).expect(400);
      await post(`/admin/users/${u.id}/suspend`, { reason: 'Fake followers' }).expect(201);
      await post(`/admin/users/${u.id}/suspend`, { reason: 'Again' }).expect(409);
      const login = await ctx.http.post('/auth/login').send({ email, password: 'password123' }).expect(403);
      expect(login.body.message).toContain('Fake followers');
      await get('/auth/me', u).expect(200); // an access token already issued still works until it expires; refresh is revoked
      await post(`/admin/users/${u.id}/unsuspend`, { reason: 'Appeal accepted' }).expect(201);
      await ctx.http.post('/auth/login').send({ email, password: 'password123' }).expect(200);
      const out = await post(`/admin/users/${u.id}/sign-out`).expect(201);
      expect(out.body.revoked).toBeGreaterThan(0);
      await post(`/admin/users/${admin.id}/suspend`, { reason: 'Nope' }).expect(409); // admins are managed under Admins
    });

    const selfie = '/9j/' + 'A'.repeat(300); // looks like a JPEG; the mock provider never reads it

    it('KYC: a wrong NIN or a selfie that does not match fails with a reason and counts; an outage does not', async () => {
      const u = await makeUser(ctx.http, 'CREATOR');
      expect((await get('/verification/kyc', u).expect(200)).body).toMatchObject({ status: 'UNVERIFIED', attemptsLeft: 3, latest: null });
      await post('/verification/kyc', { nin: '123', selfie }, u).expect(400);
      await post('/verification/kyc', { nin: '22222222222', selfie: 'short' }, u).expect(400);
      await post('/verification/kyc', { nin: '22222222222', selfie: 'not-a-photo'.repeat(20) }, u).expect(409);
      const unknown = await post('/verification/kyc', { nin: '22222222222', selfie }, u).expect(201);
      expect(unknown.body).toMatchObject({ passed: false, status: 'UNVERIFIED', attemptsLeft: 2 });
      expect(unknown.body.message).toContain('could not find that NIN');
      const noMatch = await post('/verification/kyc', { nin: '11111111111', selfie }, u).expect(201);
      expect(noMatch.body.message).toContain('did not match');
      await post('/verification/kyc', { nin: '00000000000', selfie }, u).expect(503); // provider down: not held against them
      expect((await get('/verification/kyc', u).expect(200)).body.attemptsLeft).toBe(1);
      await post('/verification/kyc', { nin: '22222222222', selfie }, u).expect(201);
      const limited = await post('/verification/kyc', { nin: '22222222222', selfie }, u).expect(429);
      expect(limited.body.code).toBe('RATE_LIMITED');
    });

    it('KYC: a match verifies the account, tells them, and one ID can verify only one account', async () => {
      const a = await makeUser(ctx.http, 'BRAND');
      const b = await makeUser(ctx.http, 'CREATOR');
      const ok = await post('/verification/kyc', { nin: '70123456789', selfie }, a).expect(201);
      expect(ok.body).toMatchObject({ passed: true, status: 'VERIFIED' });
      expect((await get('/auth/me', a).expect(200)).body.verificationStatus).toBe('VERIFIED');
      expect((await notes(a)).some((n) => n.title === 'You are verified')).toBe(true);
      await post('/verification/kyc', { nin: '70123456789', selfie }, a).expect(409); // already verified
      const clash = await post('/verification/kyc', { nin: '70123456789', selfie }, b).expect(409);
      expect(clash.body.message).toContain('already linked');
      expect((await get('/auth/me', b).expect(200)).body.verificationStatus).toBe('UNVERIFIED');

      const row = await ctx.prisma.kycVerification.findFirstOrThrow({ where: { userId: a.id, status: 'VERIFIED' } });
      expect(row.idLast4).toBe('6789');
      expect(JSON.stringify(row)).not.toContain('70123456789'); // the number itself is never stored
      const list = await get('/admin/kyc?status=VERIFIED&pageSize=100').expect(200);
      const item = list.body.items.find((r: { userId: string }) => r.userId === a.id);
      expect(item.idLast4).toBe('6789');
      expect(item).not.toHaveProperty('idHash');
      expect((await get(`/admin/users/${a.id}`).expect(200)).body.kycChecks).toHaveLength(1);
      await get('/verification/kyc', admin).expect(403); // admins do not verify themselves
      await get('/admin/kyc', a).expect(403);
    });

    it('a user can never read another person\'s ID submission', async () => {
      const a = await makeUser(ctx.http, 'CREATOR');
      await get('/admin/users', a).expect(403);
    });
  });

  // ---------- P5 money ----------

  describe('money operations', () => {
    it('filters and pages transactions, exports CSV, and shows one with its history', async () => {
      const c = await funded();
      const list = await get(`/admin/transactions?campaignId=${c.id}&kind=FUNDING`).expect(200);
      expect(list.body.total).toBe(1);
      expect(list.body.items[0]).not.toHaveProperty('providerResponse');
      const csv = await get(`/admin/transactions.csv?campaignId=${c.id}`).expect(200);
      expect(csv.headers['content-type']).toContain('text/csv');
      expect(csv.text.split('\r\n')[0]).toBe('id,createdAt,kind,purpose,status,amountNgn,feeNgn,reference,campaignId,campaign,failureReason,reconciledAt');
      expect(csv.text).toContain(c.id);
      const one = await get(`/admin/transactions/${list.body.items[0].id}`).expect(200);
      expect(one.body.brand.id).toBe(c.brand.id);
      await get('/admin/transactions?from=not-a-date').expect(400);
      await get('/admin/transactions', c.brand).expect(403);
    });

    it('marks a finished transaction reconciled once; a pending one cannot be', async () => {
      const c = await funded();
      const tx = await ctx.prisma.transaction.findFirstOrThrow({ where: { campaignId: c.id, kind: 'FUNDING' } });
      const r = await post(`/admin/transactions/${tx.id}/reconciled`, { note: 'Statement line 42' }).expect(201);
      expect(r.body.transaction.reconciledAt).not.toBeNull();
      const first = r.body.transaction.reconciledAt;
      const again = await post(`/admin/transactions/${tx.id}/reconciled`, { note: 'Statement line 42' }).expect(201);
      expect(again.body.transaction.reconciledAt).toBe(first); // idempotent
      await ctx.prisma.transaction.update({ where: { id: tx.id }, data: { status: 'pending', reconciledAt: null } });
      await post(`/admin/transactions/${tx.id}/reconciled`, { note: 'Too early' }).expect(409);
    });

    it('retry only works on a failed payout or refund', async () => {
      const c = await funded();
      const tx = await ctx.prisma.transaction.findFirstOrThrow({ where: { campaignId: c.id, kind: 'FUNDING' } });
      await post(`/admin/transactions/${tx.id}/retry`).expect(409); // not failed
      await ctx.prisma.transaction.update({ where: { id: tx.id }, data: { status: 'failed' } });
      await post(`/admin/transactions/${tx.id}/retry`).expect(409); // funding is the brand's to retry
    });

    it('an admin cancels a funded campaign: the work amount goes back, the fee stays', async () => {
      const c = await funded();
      await post(`/admin/campaigns/${c.id}/cancel`, {}).expect(400);
      await post(`/admin/campaigns/${c.id}/cancel`, { reason: 'Brand asked support to stop' }).expect(201);
      const row = await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: c.id } });
      expect(['refund_processing', 'refund_failed', 'refunded']).toContain(row.status);
      const refund = await ctx.prisma.transaction.findFirstOrThrow({ where: { campaignId: c.id, kind: 'REFUND' } });
      expect(refund.amountKobo).toBe(row.amountKobo);
      const bad = await ctx.prisma.auditLog.count({ where: { entityId: c.id, action: 'money.campaign_cancelled' } });
      expect(bad).toBe(1);
    });

    it('attention and revenue answer, and revenue counts the fee', async () => {
      await funded();
      const a = await get('/admin/money/attention').expect(200);
      for (const k of ['payoutFailed', 'refundFailed', 'approvedNoBank', 'overdue', 'stuck']) expect(Array.isArray(a.body[k])).toBe(true);
      const r = await get('/admin/money/revenue').expect(200);
      expect(r.body.feesKobo).toBeGreaterThanOrEqual(1_600_000);
      expect(r.body.byMonth.length).toBeGreaterThan(0);
      await get('/admin/money/revenue?from=garbage').expect(400);
    });

    it('lists webhook problems', async () => {
      const w = await get('/admin/webhooks?view=problems').expect(200);
      expect(Array.isArray(w.body.items)).toBe(true);
    });
  });

  // ---------- P6 moderation ----------

  describe('moderation and reports', () => {
    const brief = { title: 'Adire Handbag Launch', brief: 'Show our red adire handbag in an everyday Lagos outfit.', category: 'Fashion', budgetNgn: 200000, deadlineDays: 7, deliverables: ['1 TikTok video'] };

    it('removing a brief closes it, tells the brand, and the brand cannot republish or edit it', async () => {
      const brand = await makeUser(ctx.http, 'BRAND');
      const creator = await makeUser(ctx.http, 'CREATOR');
      const b = await post('/opportunities', brief, brand).expect(201);
      expect((await get('/opportunities/feed', creator).expect(200)).body.some((o: { id: string }) => o.id === b.body.id)).toBe(true);
      const list = await get(`/admin/briefs?status=PUBLISHED&q=${encodeURIComponent('Adire Handbag')}&pageSize=100`).expect(200);
      expect(list.body.items.some((o: { id: string }) => o.id === b.body.id)).toBe(true);
      await post(`/admin/briefs/${b.body.id}/remove`, {}).expect(400);
      await post(`/admin/briefs/${b.body.id}/remove`, { reason: 'Misleading budget' }).expect(201);
      await post(`/admin/briefs/${b.body.id}/remove`, { reason: 'Again' }).expect(409);
      expect((await get('/opportunities/feed', creator).expect(200)).body.some((o: { id: string }) => o.id === b.body.id)).toBe(false);
      await post(`/opportunities/${b.body.id}/publish`, {}, brand).expect(409);
      await ctx.http.put(`/opportunities/${b.body.id}`).set(brand.auth).send(brief).expect(409);
      expect((await notes(brand)).some((n) => n.title === 'A brief was removed' && n.body.includes('Misleading budget'))).toBe(true);
    });

    it('removing profile content works for what exists and refuses what does not', async () => {
      const creator = await makeUser(ctx.http, 'CREATOR');
      await post(`/admin/users/${creator.id}/moderate`, { action: 'remove_logo', reason: 'Not theirs' }).expect(409); // creators have no logo
      await post(`/admin/users/${creator.id}/moderate`, { action: 'remove_bio', reason: 'Offensive bio' }).expect(201);
      expect((await notes(creator)).some((n) => n.title === 'Profile content removed')).toBe(true);
    });

    it('a report: validation, dedupe, self-report, and the admin\'s decision', async () => {
      const { http } = ctx;
      const m = await makeMatch(http);
      const msg = await ctx.prisma.message.create({ data: { conversationId: m.conversationId, senderId: m.brand.id, text: 'Send me your bank PIN' } });
      const bad = { targetType: 'USER', targetId: m.brand.id, reason: 'nonsense' };
      await post('/reports', bad, m.creator).expect(400);
      await post('/reports', { targetType: 'USER', targetId: m.creator.id, reason: 'spam' }, m.creator).expect(409); // yourself
      const stranger = await makeUser(http, 'CREATOR');
      await post('/reports', { targetType: 'MESSAGE', targetId: msg.id, reason: 'scam' }, stranger).expect(404); // not in that chat
      const r = await post('/reports', { targetType: 'MESSAGE', targetId: msg.id, reason: 'scam', details: 'Asked for my PIN' }, m.creator).expect(201);
      await post('/reports', { targetType: 'MESSAGE', targetId: msg.id, reason: 'scam' }, m.creator).expect(409);
      await post('/reports', { targetType: 'USER', targetId: m.brand.id, reason: 'spam' }, admin).expect(403); // admins use the console

      expect((await get('/admin/reports?status=OPEN&targetType=MESSAGE&pageSize=100').expect(200)).body.items.some((x: { id: string }) => x.id === r.body.id)).toBe(true);
      const one = await get(`/admin/reports/${r.body.id}`).expect(200);
      expect(one.body.target.text).toBe('Send me your bank PIN');
      await post(`/admin/reports/${r.body.id}/resolve`, { action: 'remove_content', note: 'Phishing' }, m.brand).expect(403);
      await post(`/admin/reports/${r.body.id}/resolve`, { action: 'remove_content', note: 'Phishing attempt' }).expect(201);
      await post(`/admin/reports/${r.body.id}/resolve`, { action: 'dismiss', note: 'Again?' }).expect(409);
      expect((await ctx.prisma.message.findUniqueOrThrow({ where: { id: msg.id } })).text).toContain('removed by AfiCre8');
      expect((await notes(m.creator)).some((n) => n.title === 'We reviewed your report')).toBe(true);
      expect((await notes(m.brand)).some((n) => n.title === 'Content removed')).toBe(true);
    });

    it('a report can end in a suspension, or be dismissed without telling the reported person', async () => {
      const { http } = ctx;
      const a = await makeUser(http, 'CREATOR');
      const b = await makeUser(http, 'BRAND');
      const r1 = await post('/reports', { targetType: 'USER', targetId: b.id, reason: 'fake' }, a).expect(201);
      await post(`/admin/reports/${r1.body.id}/resolve`, { action: 'dismiss', note: 'Checked, fine' }).expect(201);
      expect((await notes(b)).length).toBe(0);
      const r2 = await post('/reports', { targetType: 'USER', targetId: b.id, reason: 'scam' }, a).expect(201);
      await post(`/admin/reports/${r2.body.id}/resolve`, { action: 'suspend', note: 'Confirmed scam' }).expect(201);
      expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('SUSPENDED');
    });
  });

  // ---------- P7 settings and announcements ----------

  describe('settings and announcements', () => {
    it('the fee setting changes new campaigns only, within its range, and is audited', async () => {
      const before = await funded();
      expect((await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: before.id } })).feeKobo).toBe(1_600_000);
      await ctx.http.put('/admin/settings/platformFeeBps').set(admin.auth).send({ value: 5000 }).expect(409); // above the allowed range
      await ctx.http.put('/admin/settings/nonsense').set(admin.auth).send({ value: 1 }).expect(409);
      await ctx.http.put('/admin/settings/platformFeeBps').set(admin.auth).send({ value: 1000 }).expect(200);
      try {
        const m = await makeMatch(ctx.http);
        const c = await ctx.http.post('/campaigns').set(m.brand.auth).send({ matchId: m.matchId, ...sampleTerms() }).expect(201);
        expect(c.body.feeKobo).toBe(2_000_000); // 10% of ₦200,000
        expect((await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: before.id } })).feeKobo).toBe(1_600_000); // untouched
      } finally {
        await ctx.http.put('/admin/settings/platformFeeBps').set(admin.auth).send({ value: 800 }).expect(200);
      }
      const log = await get('/admin/audit?action=settings.changed&entity=Setting').expect(200);
      expect(log.body.items.length).toBeGreaterThanOrEqual(2);
      expect((await get('/admin/settings').expect(200)).body.map((s: { key: string }) => s.key)).toEqual(['platformFeeBps', 'disputeResponseHours', 'overdueRefundGraceDays']);
    });

    it('the response window setting applies to new disputes', async () => {
      await ctx.http.put('/admin/settings/disputeResponseHours').set(admin.auth).send({ value: 24 }).expect(200);
      try {
        const c = await funded();
        await ctx.http.post(`/campaigns/${c.id}/dispute`).set(c.creator.auth).send({ reason: 'The brief was changed after we agreed.', evidence: [] }).expect(201);
        const d = await ctx.prisma.dispute.findFirstOrThrow({ where: { campaignId: c.id } });
        expect(Math.round((d.respondBy!.getTime() - d.createdAt.getTime()) / 3600_000)).toBe(24);
      } finally {
        await ctx.http.put('/admin/settings/disputeResponseHours').set(admin.auth).send({ value: 72 }).expect(200);
      }
    });

    it('an announcement reaches the audience, only once, and only a super admin can send it', async () => {
      const brand = await makeUser(ctx.http, 'BRAND');
      const creator = await makeUser(ctx.http, 'CREATOR');
      const support = await adminWith('SUPPORT');
      const body = { title: `Maintenance ${Date.now()}`, body: 'The app is briefly offline on Sunday at 2am.', audience: 'BRANDS' };
      await post('/admin/announcements', body, support).expect(403);
      await post('/admin/announcements', { ...body, title: 'x' }).expect(400);
      const sent = await post('/admin/announcements', body).expect(201);
      expect(sent.body.sentCount).toBeGreaterThanOrEqual(1);
      expect((await notes(brand)).some((n) => n.title === body.title)).toBe(true);
      expect((await notes(creator)).some((n) => n.title === body.title)).toBe(false); // brands only
      await post('/admin/announcements', body).expect(409); // double click
      expect((await get('/admin/announcements').expect(200)).body[0].title).toBe(body.title);
    });
  });

  // ---------- P8 reporting, audit, admin accounts, 2FA ----------

  describe('reporting, audit and admin accounts', () => {
    it('the timeseries has one entry per day', async () => {
      const s = await get('/admin/stats/timeseries?days=7').expect(200);
      expect(s.body.series).toHaveLength(7);
      expect(Object.keys(s.body.series[0])).toEqual(['day', 'brands', 'creators', 'campaigns', 'fundedKobo', 'feesKobo', 'disputes']);
      await get('/admin/stats/timeseries?days=9999').expect(400);
    });

    it('the audit log filters, pages and exports', async () => {
      const u = await makeUser(ctx.http, 'BRAND');
      await post(`/admin/users/${u.id}/notes`, { note: 'audit me' }).expect(201);
      const a = await get(`/admin/audit?entity=User&entityId=${u.id}&action=note`).expect(200);
      expect(a.body.items).toHaveLength(1);
      expect(a.body.items[0].actor.id).toBe(admin.id);
      const csv = await get(`/admin/audit.csv?entityId=${u.id}`).expect(200);
      expect(csv.text).toContain('admin.user_note_added');
      await get('/admin/audit?from=nope').expect(400);
    });

    it('roles limit actions but not reading; only a super admin manages admins', async () => {
      const support = await adminWith('SUPPORT');
      const finance = await adminWith('FINANCE');
      const u = await makeUser(ctx.http, 'CREATOR');
      const c = await funded();
      await get('/admin/transactions', support).expect(200); // everyone reads
      await post(`/admin/users/${u.id}/suspend`, { reason: 'Test' }, finance).expect(403);
      await post(`/admin/campaigns/${c.id}/cancel`, { reason: 'Test' }, support).expect(403);
      await post(`/admin/users/${u.id}/suspend`, { reason: 'Test' }, support).expect(201);
      await post('/admin/admins', { email: 'x@test.africre8.dev', password: 'password123456', role: 'SUPER' }, support).expect(403);
      const me = await get('/admin/me', finance).expect(200);
      expect(me.body.role).toBe('FINANCE');
      await post(`/admin/admins/${finance.id}/role`, { role: 'SUPPORT' }).expect(201);
      expect((await get('/admin/me', finance).expect(200)).body.role).toBe('SUPPORT');
      await post(`/admin/admins/${admin.id}/disable`).expect(409); // not yourself
      await post(`/admin/admins/${support.id}/disable`).expect(201);
      await ctx.http.post('/auth/login').send({ email: (await ctx.prisma.user.findUniqueOrThrow({ where: { id: support.id } })).email, password: 'password123456' }).expect(403);
      await post('/admin/admins', { email: adminEmail, password: 'password123456', role: 'SUPPORT' }).expect(409); // email taken
      await post('/admin/admins', { email: 'short@test.africre8.dev', password: 'short', role: 'SUPPORT' }).expect(400);
    });

    it('two-factor sign-in: set up, required at login, wrong code refused, reset by a super admin', async () => {
      const other = await adminWith('SUPER');
      const email = (await ctx.prisma.user.findUniqueOrThrow({ where: { id: other.id } })).email;
      await post('/admin/2fa/enable', { code: '123456' }, other).expect(400); // not started
      const setup = await post('/admin/2fa/setup', {}, other).expect(201);
      expect(setup.body.otpauthUri).toContain('otpauth://totp/');
      await post('/admin/2fa/enable', { code: '000000' }, other).expect(400);
      await post('/admin/2fa/enable', { code: codeAt(setup.body.secret, Date.now()) }, other).expect(201);
      const login = (totp?: string) => ctx.http.post('/auth/login').send({ email, password: 'password123456', ...(totp ? { totp } : {}) });
      expect((await login().expect(401)).body.code).toBe('TOTP_REQUIRED');
      await login('000000').expect(401);
      const ok = await login(codeAt(setup.body.secret, Date.now())).expect(200);
      expect(ok.body.user).not.toHaveProperty('totpSecret');
      expect((await get('/auth/me', other).expect(200)).body).not.toHaveProperty('totpSecret');
      await post(`/admin/admins/${other.id}/reset-2fa`).expect(201);
      await login().expect(200); // reset: password alone works again
    });
  });
});
