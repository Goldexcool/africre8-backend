process.env.PAYMENT_PROVIDER = 'mock';

import { CampaignStateMachine } from '../src/campaigns/state-machine.js';
import { PaymentsService } from '../src/payments/payments.service.js';
import { bootApp, cleanup, makeMatch, sampleTerms } from './helpers.js';

describe('Payments (e2e, mock provider)', () => {
  let ctx: Awaited<ReturnType<typeof bootApp>>;

  beforeAll(async () => {
    ctx = await bootApp();
  });

  afterAll(async () => {
    await cleanup(ctx.prisma);
    await ctx.app.close();
  });

  async function agreedCampaign() {
    const m = await makeMatch(ctx.http);
    const c = await ctx.http.post('/campaigns').set(m.brand.auth).send({ matchId: m.matchId, ...sampleTerms() }).expect(201);
    await ctx.http.post(`/campaigns/${c.body.id}/accept`).set(m.creator.auth).send({ termsVersion: 1 }).expect(201);
    return { ...m, campaignId: c.body.id as string };
  }

  async function toApproved(campaignId: string) {
    const sm = ctx.app.get(CampaignStateMachine);
    for (const s of ['submitted', 'under_review', 'approved'] as const) await sm.transition(campaignId, s);
  }

  const webhook = (reference: string, transaction_status: string) =>
    ctx.http.post('/webhooks/payaza').send({ transaction_reference: reference, transaction_status }).expect(200);

  it('funds only on provider confirmation, dedupes webhooks, pays out exactly once', async () => {
    const { http } = ctx;
    const { brand, creator, campaignId } = await agreedCampaign();

    const f1 = await http.post(`/campaigns/${campaignId}/fund`).set(brand.auth).send({ method: 'bank_transfer' }).expect(201);
    const f2 = await http.post(`/campaigns/${campaignId}/fund`).set(brand.auth).send({ method: 'bank_transfer' }).expect(201);
    expect(f2.body.id).toBe(f1.body.id); // same live attempt, not a second charge
    expect(f1.body.totalNgn).toBe(210000); // ₦200k + 5% fee
    expect(f1.body.instructions.accountNumber).toBeTruthy();

    // A webhook claiming success is only a hint; Payaza (mock) still says pending → not funded.
    await webhook(f1.body.payazaReference, 'Funds Received');
    let c = await http.get(`/campaigns/${campaignId}`).set(brand.auth).expect(200);
    expect(c.body.status).toBe('awaiting_funding');

    const sim = await http.post(`/campaigns/${campaignId}/fund/simulate`).set(brand.auth).expect(201);
    expect(sim.body.transaction.status).toBe('successful');
    c = await http.get(`/campaigns/${campaignId}`).set(creator.auth).expect(200);
    expect(c.body.status).toBe('funded');
    expect(c.body.fundedAt).toBeTruthy();

    // Same event replayed: stored once, no side effects.
    const dupe = await webhook(f1.body.payazaReference, 'Completed');
    const dupe2 = await webhook(f1.body.payazaReference, 'Completed');
    expect(dupe.body.duplicate).toBe(false);
    expect(dupe2.body.duplicate).toBe(true);

    await http.post(`/campaigns/${campaignId}/start`).set(creator.auth).expect(201);
    await toApproved(campaignId);

    await http.put('/profiles/payout-destination').set(creator.auth).send({ bankCode: '000013', bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Test Creator' }).expect(200);
    const payouts = ctx.app.get(PaymentsService);
    const p = await payouts.payout(campaignId);
    expect(p.status).toBe('processing');
    await expect(payouts.payout(campaignId)).rejects.toThrow(/Campaign is payout_processing|already in progress/);

    await payouts.reconcile(p.id);
    c = await http.get(`/campaigns/${campaignId}`).set(creator.auth).expect(200);
    expect(c.body.status).toBe('completed');
    const kinds = c.body.transactions.map((t: { kind: string; status: string }) => `${t.kind}:${t.status}`);
    expect(kinds).toEqual(['FUNDING:successful', 'PAYOUT:successful']);
    expect(c.body.history.map((h: { toState: string }) => h.toState)).toContain('completed');

    const txs = await http.get('/transactions').set(creator.auth).expect(200);
    expect(txs.body.length).toBe(2);
  });

  it('failed payout stays payout_failed (never completed) and can be retried', async () => {
    const { http } = ctx;
    const { brand, creator, campaignId } = await agreedCampaign();
    await http.post(`/campaigns/${campaignId}/fund`).set(brand.auth).send({ method: 'card' }).expect(201);
    await http.post(`/campaigns/${campaignId}/fund/simulate`).set(brand.auth).expect(404); // simulate is bank-transfer only
    const payments = ctx.app.get(PaymentsService);
    const tx = await ctx.prisma.transaction.findFirstOrThrow({ where: { campaignId } });
    (payments.provider as unknown as { setStatus(r: string, s: string): void }).setStatus(tx.payazaReference, 'successful');
    await payments.reconcileAll(0);
    await toApproved(campaignId);

    await http.put('/profiles/payout-destination').set(creator.auth).send({ bankCode: '000013', bankName: 'GTBank', accountNumber: '0000000000', accountName: 'Bad Account' }).expect(200);
    const p = await payments.payout(campaignId);
    await payments.reconcile(p.id);
    let c = await http.get(`/campaigns/${campaignId}`).set(brand.auth).expect(200);
    expect(c.body.status).toBe('payout_failed');

    await http.put('/profiles/payout-destination').set(creator.auth).send({ bankCode: '000013', bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Good Account' }).expect(200);
    const retry = await payments.payout(campaignId);
    await payments.reconcile(retry.id);
    c = await http.get(`/campaigns/${campaignId}`).set(brand.auth).expect(200);
    expect(c.body.status).toBe('completed');
  });
});
