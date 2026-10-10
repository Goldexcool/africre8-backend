process.env.PAYMENT_PROVIDER = 'mock';

import { bootApp, cleanup, makeMatch, makeUser, sampleTerms } from './helpers.js';
import { PaymentsService } from '../src/payments/payments.service.js';
import { ReviewService } from '../src/review/review.module.js';

/** Disputes: the other side's response, the 72-hour flag, the admin queue, notes, assignment and the split. Mock provider. */
describe('Disputes (e2e)', () => {
  let ctx: Awaited<ReturnType<typeof bootApp>>;
  let aauth: { Authorization: string };
  let adminId: string;

  beforeAll(async () => {
    ctx = await bootApp();
    const u = await makeUser(ctx.http, 'CREATOR');
    const { email } = await ctx.prisma.user.update({ where: { id: u.id }, data: { role: 'ADMIN' } });
    const login = await ctx.http.post('/auth/login').send({ email, password: 'password123' }).expect(200);
    aauth = { Authorization: `Bearer ${login.body.accessToken}` };
    adminId = u.id;
  });
  afterAll(async () => { await cleanup(ctx.prisma); await ctx.app.close(); });

  const bank = (accountNumber = '0123456789') => ({ bankCode: '000013', bankName: 'GTBank', accountNumber });

  /** A funded campaign (work ₦200,000, fee 8%). */
  async function funded() {
    const { http } = ctx;
    const m = await makeMatch(http);
    const c = await http.post('/campaigns').set(m.brand.auth).send({ matchId: m.matchId, ...sampleTerms() }).expect(201);
    await http.post(`/campaigns/${c.body.id}/accept`).set(m.creator.auth).send({ termsVersion: 1 }).expect(201);
    await http.post(`/campaigns/${c.body.id}/fund`).set(m.brand.auth).send({ method: 'bank_transfer' }).expect(201);
    await http.post(`/campaigns/${c.body.id}/fund/simulate`).set(m.brand.auth).expect(201);
    return { ...m, id: c.body.id as string };
  }
  const raise = (who: { auth: Record<string, string> }, id: string, reason = 'The delivered video does not match the agreed brief.') =>
    ctx.http.post(`/campaigns/${id}/dispute`).set(who.auth).send({ reason, evidence: ['https://example.com/proof.png'] }).expect(201);
  const disputeOf = (campaignId: string) => ctx.prisma.dispute.findFirstOrThrow({ where: { campaignId } });
  const notes = async (who: { auth: Record<string, string> }) => (await ctx.http.get('/notifications').set(who.auth).expect(200)).body as { title: string; body: string }[];
  const campaignRow = (id: string) => ctx.prisma.campaign.findUniqueOrThrow({ where: { id } });
  const txs = (id: string, kind: 'PAYOUT' | 'REFUND') => ctx.prisma.transaction.findMany({ where: { campaignId: id, kind }, orderBy: { createdAt: 'asc' } });
  const settleAll = async (id: string) => { for (const t of await ctx.prisma.transaction.findMany({ where: { campaignId: id, kind: { in: ['PAYOUT', 'REFUND'] } } })) await ctx.app.get(PaymentsService).reconcile(t.id); };
  const resolve = (disputeId: string, body: Record<string, unknown>) => ctx.http.post(`/admin/disputes/${disputeId}/resolve`).set(aauth).send(body);

  it('the platform fee is 8% of the work amount, charged on top', async () => {
    const c = await campaignRow((await funded()).id);
    expect(c.amountKobo).toBe(20_000_000);
    expect(c.feeKobo).toBe(1_600_000);
  });

  it('raising a dispute gives the other side 72 hours and tells them', async () => {
    const { brand, creator, id } = await funded();
    await raise(creator, id);
    const d = await disputeOf(id);
    expect(d.respondBy).not.toBeNull();
    expect(Math.abs(d.respondBy!.getTime() - d.createdAt.getTime() - 72 * 3600_000)).toBeLessThan(60_000);
    expect((await notes(brand)).some((n) => n.title === 'Dispute raised' && n.body.includes('72 hours'))).toBe(true);
  });

  it('only the other party can respond, once, while the dispute is open', async () => {
    const { http } = ctx;
    const { brand, creator, id } = await funded();
    const stranger = await makeUser(http, 'BRAND');
    const body = { reason: 'The brief changed after we agreed, so the video matches the first brief.', evidence: ['https://example.com/brief.pdf'] };
    await http.post(`/campaigns/${id}/dispute/respond`).set(brand.auth).send(body).expect(409); // no open dispute yet
    await raise(creator, id);
    await http.post(`/campaigns/${id}/dispute/respond`).set(creator.auth).send(body).expect(403); // the raiser cannot answer themselves
    await http.post(`/campaigns/${id}/dispute/respond`).set(stranger.auth).send(body).expect(404); // not a party
    await http.post(`/campaigns/${id}/dispute/respond`).set(brand.auth).send({ reason: 'no', evidence: [] }).expect(400);
    const r = await http.post(`/campaigns/${id}/dispute/respond`).set(brand.auth).send(body).expect(201);
    expect(r.body.disputes[0].responseReason).toBe(body.reason);
    expect(r.body.disputes[0].respondedAt).not.toBeNull();
    const again = await http.post(`/campaigns/${id}/dispute/respond`).set(brand.auth).send(body).expect(409);
    expect(again.body.code).toBe('ALREADY_RESPONDED');
    expect((await notes(creator)).some((n) => n.title === 'They responded to your dispute')).toBe(true);
    expect((await notes({ auth: aauth })).some((n) => n.title === 'Dispute response received')).toBe(true);
  });

  it('after 72 hours with no response the dispute is flagged once; a late response clears the flag', async () => {
    const { brand, creator, id } = await funded();
    await raise(creator, id);
    const d = await disputeOf(id);
    const review = ctx.app.get(ReviewService);
    await review.flagOverdueDisputes();
    expect((await disputeOf(id)).noResponse).toBe(false); // still inside the window
    await ctx.prisma.dispute.update({ where: { id: d.id }, data: { respondBy: new Date(Date.now() - 60_000) } });
    expect(await review.flagOverdueDisputes()).toBeGreaterThanOrEqual(1);
    expect((await disputeOf(id)).noResponse).toBe(true);
    expect((await notes({ auth: aauth })).some((n) => n.title === 'Dispute with no response')).toBe(true);
    await ctx.prisma.dispute.updateMany({ where: { noResponse: true, id: { not: d.id } }, data: { noResponse: false } }); // other tests' leftovers
    expect(await review.flagOverdueDisputes()).toBe(0); // flagged once, not every run
    await ctx.http.post(`/campaigns/${id}/dispute/respond`).set(brand.auth).send({ reason: 'Sorry for the delay, here is our side.', evidence: [] }).expect(201);
    expect((await disputeOf(id)).noResponse).toBe(false);
  });

  it('the admin queue filters and pages, and is for admins only', async () => {
    const { http } = ctx;
    const a = await funded();
    const b = await funded();
    await raise(a.creator, a.id);
    await raise(b.brand, b.id);
    const bd = await disputeOf(b.id);
    await ctx.prisma.dispute.update({ where: { id: bd.id }, data: { noResponse: true } });

    const mine = await http.get(`/admin/disputes?campaignId=${a.id}&status=ALL`).set(aauth).expect(200);
    expect(mine.body).toMatchObject({ total: 1, page: 1 });
    const row = mine.body.items[0];
    expect(row).toMatchObject({ status: 'OPEN', noResponse: false, responded: false, assignedTo: null });
    expect(row.campaign).toMatchObject({ id: a.id, amountKobo: 20_000_000, feeKobo: 1_600_000 });
    expect(row.raisedBy.role).toBe('CREATOR');
    expect(row.otherParty.role).toBe('BRAND');

    const flagged = await http.get('/admin/disputes?noResponse=true&pageSize=100').set(aauth).expect(200);
    expect(flagged.body.items.map((i: { id: string }) => i.id)).toContain(bd.id);
    expect(flagged.body.items.every((i: { noResponse: boolean }) => i.noResponse)).toBe(true);
    const page1 = await http.get('/admin/disputes?status=OPEN&pageSize=1').set(aauth).expect(200);
    expect(page1.body.items).toHaveLength(1);
    expect(page1.body.total).toBeGreaterThanOrEqual(2);
    await http.get('/admin/disputes?pageSize=0').set(aauth).expect(400);
    await http.get('/admin/disputes').set(a.brand.auth).expect(403);
    await http.get('/admin/disputes').expect(401);
  });

  it('the detail has both statements and no verification frames; notes are admin-only; assignment works', async () => {
    const { http } = ctx;
    const { brand, creator, id } = await funded();
    await raise(creator, id);
    await http.post(`/campaigns/${id}/dispute/respond`).set(brand.auth).send({ reason: 'We deny this: the video matches.', evidence: ['https://example.com/b.png'] }).expect(201);
    const d = await disputeOf(id);

    const detail = (await http.get(`/admin/disputes/${d.id}`).set(aauth).expect(200)).body;
    expect(detail.dispute).toMatchObject({ reason: 'The delivered video does not match the agreed brief.', evidence: ['https://example.com/proof.png'], raisedById: creator.id });
    expect(detail.dispute.response).toMatchObject({ reason: 'We deny this: the video matches.', evidence: ['https://example.com/b.png'], byId: brand.id });
    expect(detail.brand.role).toBe('BRAND');
    expect(detail.creator.role).toBe('CREATOR');
    expect(detail.campaign.id).toBe(id);
    expect(JSON.stringify(detail.campaign.submissions)).not.toContain('"evidence"'); // frames and transcripts are left out

    const note = await http.post(`/admin/disputes/${d.id}/notes`).set(aauth).send({ note: 'Called the brand; they will send the original brief.' }).expect(201);
    expect(note.body.admin.id).toBe(adminId);
    await http.post(`/admin/disputes/${d.id}/notes`).set(aauth).send({ note: '   ' }).expect(400);
    const again = (await http.get(`/admin/disputes/${d.id}`).set(aauth).expect(200)).body;
    expect(again.notes.map((n: { note: string }) => n.note)).toEqual(['Called the brand; they will send the original brief.']);
    const seenByBrand = JSON.stringify((await http.get(`/campaigns/${id}`).set(brand.auth).expect(200)).body);
    expect(seenByBrand).not.toContain('Called the brand'); // internal notes never reach the parties
    await http.post(`/admin/disputes/${d.id}/notes`).set(brand.auth).send({ note: 'x' }).expect(403);

    expect((await http.post(`/admin/disputes/${d.id}/assign`).set(aauth).send({ adminId }).expect(201)).body.assignedTo.id).toBe(adminId);
    expect((await http.get(`/admin/disputes?campaignId=${id}&assigned=me`).set(aauth).expect(200)).body.total).toBe(1);
    await http.post(`/admin/disputes/${d.id}/assign`).set(aauth).send({ adminId: brand.id }).expect(404); // only an admin can hold it
    expect((await http.post(`/admin/disputes/${d.id}/assign`).set(aauth).send({ adminId: null }).expect(201)).body.assignedTo).toBeNull();
    await http.get('/admin/disputes/00000000-0000-0000-0000-000000000000').set(aauth).expect(404);
  });

  it('a refund returns the work amount only; the platform keeps its fee', async () => {
    const { http } = ctx;
    const { brand, creator, id } = await funded();
    await http.put('/profiles/refund-account').set(brand.auth).send(bank()).expect(200);
    await raise(creator, id);
    const d = await disputeOf(id);
    await resolve(d.id, { outcome: 'refund', resolution: 'The brand is refunded the work amount.' }).expect(201);
    const [t] = await txs(id, 'REFUND');
    expect(t.amountKobo).toBe(20_000_000);
    expect(t.amountKobo).toBeLessThan(20_000_000 + 1_600_000);
  });

  it('a split pays the creator their share and returns the rest of the work amount to the brand; the platform keeps its fee', async () => {
    const { http } = ctx;
    const { brand, creator, id } = await funded();
    await http.put('/profiles/payout-destination').set(creator.auth).send(bank()).expect(200);
    await http.put('/profiles/refund-account').set(brand.auth).send(bank('0987654321')).expect(200);
    await raise(brand, id);
    const d = await disputeOf(id);

    for (const bad of [{}, { creatorPercent: 0 }, { creatorPercent: 100 }, { creatorPercent: 60.5 }]) {
      await resolve(d.id, { outcome: 'split', resolution: 'Split it fairly between both sides.', ...bad }).expect(400);
    }
    expect((await disputeOf(id)).status).toBe('OPEN'); // nothing happened on the bad requests

    await resolve(d.id, { outcome: 'split', creatorPercent: 60, resolution: 'The creator delivered most of the work, so 60/40.' }).expect(201);
    const after = await disputeOf(id);
    expect(after).toMatchObject({ status: 'RESOLVED_SPLIT', splitCreatorKobo: 12_000_000, splitBrandKobo: 8_000_000 });
    const c = await campaignRow(id);
    expect(c.payoutKobo).toBe(12_000_000);
    expect(c.status).toBe('payout_processing'); // the campaign follows the creator's payout

    const [payout] = await txs(id, 'PAYOUT');
    const [refund] = await txs(id, 'REFUND');
    expect(payout.amountKobo).toBe(12_000_000);
    expect(refund).toMatchObject({ amountKobo: 8_000_000, purpose: 'DISPUTE_SPLIT' });
    expect(payout.amountKobo + refund.amountKobo).toBe(c.amountKobo); // the fee (1,600,000) is neither paid out nor refunded

    await settleAll(id);
    expect((await campaignRow(id)).status).toBe('completed'); // the refund leg did not change the campaign state
    expect((await txs(id, 'REFUND'))[0].status).toBe('successful');
    expect((await notes(creator)).some((n) => n.title === 'Dispute resolved' && n.body.includes('₦120,000'))).toBe(true);
    expect((await notes(brand)).some((n) => n.title === 'Dispute resolved' && n.body.includes('₦80,000') && n.body.includes('fee is kept'))).toBe(true);
    await resolve(d.id, { outcome: 'split', creatorPercent: 50, resolution: 'Trying to resolve it a second time.' }).expect(404); // decided once
  });

  it('a split waits for missing bank details and then pays the split amounts, not the full amount', async () => {
    const { http } = ctx;
    const { brand, creator, id } = await funded();
    await raise(creator, id);
    const d = await disputeOf(id);
    await resolve(d.id, { outcome: 'split', creatorPercent: 25, resolution: 'The creator delivered a quarter of the work.' }).expect(201);
    expect((await campaignRow(id)).status).toBe('approved'); // creator has no payout account yet
    const failed = await txs(id, 'REFUND');
    expect(failed.map((t) => t.status)).toEqual(['failed']); // brand has no refund account yet

    await http.put('/profiles/payout-destination').set(creator.auth).send(bank()).expect(200);
    const [payout] = await txs(id, 'PAYOUT');
    expect(payout.amountKobo).toBe(5_000_000); // 25% of ₦200,000, not the whole amount

    await http.put('/profiles/refund-account').set(brand.auth).send(bank('0987654321')).expect(200);
    const refunds = await txs(id, 'REFUND');
    expect(refunds.map((t) => t.status)).toEqual(['failed', expect.stringMatching(/processing|pending/)]);
    expect(refunds[1].amountKobo).toBe(15_000_000);
    await settleAll(id);
    expect((await txs(id, 'REFUND')).map((t) => t.status)).toEqual(['failed', 'successful']);
    expect((await campaignRow(id)).status).toBe('completed');
  });

  it('the worker creates a split refund that never got created, and does it only once', async () => {
    const { creator, id } = await funded();
    await raise(creator, id);
    const d = await disputeOf(id);
    await resolve(d.id, { outcome: 'split', creatorPercent: 70, resolution: 'The creator delivered most of the work.' }).expect(201);
    await ctx.prisma.transaction.deleteMany({ where: { campaignId: id, kind: 'REFUND' } }); // as if the process died between the two steps
    const review = ctx.app.get(ReviewService);
    expect(await review.ensureSplitRefunds()).toBeGreaterThanOrEqual(1);
    const [refund] = await txs(id, 'REFUND');
    expect(refund).toMatchObject({ amountKobo: 6_000_000, purpose: 'DISPUTE_SPLIT' });
    await review.ensureSplitRefunds();
    expect(await txs(id, 'REFUND')).toHaveLength(1);
  });
});
