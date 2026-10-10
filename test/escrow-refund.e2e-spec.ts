process.env.PAYMENT_PROVIDER = 'mock';

import { bootApp, cleanup, makeAdmin, makeMatch, sampleTerms } from './helpers.js';
import { PaymentsService } from '../src/payments/payments.service.js';

/** The money-back half of escrow: cancel, refund account, dispute refund, overdue refund. Mock provider. */
describe('Escrow refunds (e2e)', () => {
  let ctx: Awaited<ReturnType<typeof bootApp>>;
  beforeAll(async () => { ctx = await bootApp(); });
  afterAll(async () => { await cleanup(ctx.prisma); await ctx.app.close(); });

  const bank = (accountNumber = '0123456789') => ({ bankCode: '000013', bankName: 'GTBank', accountNumber });

  async function campaign(fund: boolean) {
    const { http } = ctx;
    const m = await makeMatch(http);
    const c = await http.post('/campaigns').set(m.brand.auth).send({ matchId: m.matchId, ...sampleTerms() }).expect(201);
    await http.post(`/campaigns/${c.body.id}/accept`).set(m.creator.auth).send({ termsVersion: 1 }).expect(201);
    if (fund) {
      await http.post(`/campaigns/${c.body.id}/fund`).set(m.brand.auth).send({ method: 'bank_transfer' }).expect(201);
      await http.post(`/campaigns/${c.body.id}/fund/simulate`).set(m.brand.auth).expect(201);
    }
    return { ...m, id: c.body.id as string };
  }
  const status = async (id: string) => (await ctx.prisma.campaign.findUniqueOrThrow({ where: { id } })).status;
  const refundTx = (id: string) => ctx.prisma.transaction.findMany({ where: { campaignId: id, kind: 'REFUND' }, orderBy: { createdAt: 'asc' } });
  const settle = async (id: string) => { for (const t of await refundTx(id)) await ctx.app.get(PaymentsService).reconcile(t.id); };

  it('cancelling before funding just closes the campaign', async () => {
    const { http } = ctx;
    const { brand, creator, id } = await campaign(false);
    await http.post(`/campaigns/${id}/cancel`).set(creator.auth).send({}).expect(403);
    await http.post(`/campaigns/${id}/cancel`).set(brand.auth).send({}).expect(201);
    expect(await status(id)).toBe('cancelled');
    expect(await refundTx(id)).toHaveLength(0);
    await http.post(`/campaigns/${id}/fund`).set(brand.auth).send({ method: 'card' }).expect(409);
  });

  it('cancelling a funded campaign refunds the full amount including the fee', async () => {
    const { http } = ctx;
    const { brand, id } = await campaign(true);
    await http.put('/profiles/refund-account').set(brand.auth).send(bank()).expect(200);
    await http.post(`/campaigns/${id}/cancel`).set(brand.auth).send({ reason: 'Plans changed' }).expect(201);
    const c = await ctx.prisma.campaign.findUniqueOrThrow({ where: { id } });
    expect(c.status).toBe('refund_processing');
    const [t] = await refundTx(id);
    expect(t.amountKobo).toBe(c.amountKobo + c.feeKobo);
    await settle(id);
    expect(await status(id)).toBe('refunded');
    await http.post(`/campaigns/${id}/cancel`).set(brand.auth).send({}).expect(409); // not twice
  });

  it('with no refund account the refund waits as refund_failed, and saving one sends it', async () => {
    const { http } = ctx;
    const { brand, id } = await campaign(true);
    await http.post(`/campaigns/${id}/cancel`).set(brand.auth).send({}).expect(201);
    expect(await status(id)).toBe('refund_failed');
    await http.put('/profiles/refund-account').set(brand.auth).send(bank()).expect(200);
    expect(await status(id)).toBe('refund_processing');
    await settle(id);
    expect(await status(id)).toBe('refunded');
  });

  it('a bank-returned refund fails, and a good account retries it', async () => {
    const { http } = ctx;
    const { brand, id } = await campaign(true);
    await http.put('/profiles/refund-account').set(brand.auth).send(bank('0000000000')).expect(200);
    await http.post(`/campaigns/${id}/cancel`).set(brand.auth).send({}).expect(201);
    await settle(id); // the mock bank returns this account on the first provider check
    expect(await status(id)).toBe('refund_failed');
    await http.put('/profiles/refund-account').set(brand.auth).send(bank()).expect(200);
    await settle(id);
    expect(await status(id)).toBe('refunded');
    expect((await refundTx(id)).map((t) => t.status)).toEqual(['failed', 'successful']);
  });

  it('an admin can resolve a dispute with a refund, and the payout stays blocked', async () => {
    const { http } = ctx;
    const { brand, creator, id } = await campaign(true);
    await http.put('/profiles/refund-account').set(brand.auth).send(bank()).expect(200);
    await http.post(`/campaigns/${id}/dispute`).set(creator.auth).send({ reason: 'Brand went silent after funding' }).expect(201);
    const aauth = await makeAdmin(http, ctx.prisma);
    const d = (await http.get('/admin/disputes').set(aauth).expect(200)).body.find((x: { campaignId: string }) => x.campaignId === id);
    await http.post(`/admin/disputes/${d.id}/resolve`).set(aauth).send({ outcome: 'refund', resolution: 'Brand is refunded in full' }).expect(201);
    await settle(id);
    expect(await status(id)).toBe('refunded');
    await http.post(`/campaigns/${id}/approve`).set(brand.auth).expect(409);
  });

  it('funded work past its deadline plus grace is refunded by the worker job', async () => {
    const { brand, id } = await campaign(true);
    await ctx.app.get(PaymentsService).refundOverdue(); // not overdue: untouched
    expect(await status(id)).toBe('funded');
    await ctx.prisma.campaign.update({ where: { id }, data: { deadline: new Date(Date.now() - 4 * 24 * 3600_000) } });
    await ctx.http.put('/profiles/refund-account').set(brand.auth).send(bank()).expect(200);
    await ctx.app.get(PaymentsService).refundOverdue();
    await settle(id);
    expect(await status(id)).toBe('refunded');
  });
});
