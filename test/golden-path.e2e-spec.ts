process.env.PAYMENT_PROVIDER = 'mock';

import { PaymentsService } from '../src/payments/payments.service.js';
import { VerificationService, verdictFor } from '../src/verification/verification.service.js';
import { bootApp, cleanup, makeAdmin, makeMatch, sampleTerms } from './helpers.js';

/** PRD "Acceptance Criteria (End-to-End Flow)", driven through the HTTP API with the mock provider. */
describe('Golden path (e2e)', () => {
  let ctx: Awaited<ReturnType<typeof bootApp>>;

  beforeAll(async () => {
    ctx = await bootApp();
  });

  afterAll(async () => {
    await cleanup(ctx.prisma);
    await ctx.app.close();
  });

  /** Stand-in for the worker: records a finished verification for every live submission. */
  async function verified(campaignId: string, verdict: 'PASS' | 'PARTIAL' = 'PASS') {
    const subs = await ctx.prisma.submission.findMany({ where: { campaignId, superseded: false } });
    for (const s of subs) {
      await ctx.prisma.verificationRun.create({
        data: { submissionId: s.id, verdict, checks: [{ label: 'Red handbag featured', passed: true, kind: 'ai', confidence: 0.9 }], summary: 'Looks good', finishedAt: new Date() },
      });
    }
    await ctx.app.get(VerificationService).maybeReadyForReview(campaignId);
  }

  async function funded() {
    const { http } = ctx;
    const m = await makeMatch(http);
    const c = await http.post('/campaigns').set(m.brand.auth).send({ matchId: m.matchId, ...sampleTerms({ revisionLimit: 1 }) }).expect(201);
    await http.post(`/campaigns/${c.body.id}/accept`).set(m.creator.auth).send({ termsVersion: 1 }).expect(201);
    await http.post(`/campaigns/${c.body.id}/fund`).set(m.brand.auth).send({ method: 'bank_transfer' }).expect(201);
    await http.post(`/campaigns/${c.body.id}/fund/simulate`).set(m.brand.auth).expect(201);
    return { ...m, campaign: c.body };
  }

  it('discover → match → agree → fund → submit → verify → approve → payout → completed', async () => {
    const { http } = ctx;
    const { brand, creator, campaign } = await funded();
    const id = campaign.id;
    const reqId = campaign.requirements[0].id;

    await http.post(`/campaigns/${id}/submissions`).set(creator.auth).send({ requirementId: reqId, contentUrl: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' }).expect(400); // wrong platform
    const sub = await http.post(`/campaigns/${id}/submissions`).set(creator.auth).send({ requirementId: reqId, contentUrl: 'https://www.tiktok.com/@testcreator/video/7300000000000000000' }).expect(201);
    expect(sub.body.status).toBe('submitted');

    await verified(id);
    let c = await http.get(`/campaigns/${id}`).set(brand.auth).expect(200);
    expect(c.body.status).toBe('under_review');

    // Approve before bank details: stays approved, creator is asked for an account.
    await http.post(`/campaigns/${id}/approve`).set(creator.auth).expect(403);
    c = await http.post(`/campaigns/${id}/approve`).set(brand.auth).expect(201);
    expect(c.body.status).toBe('approved');

    // Adding bank details releases the payout automatically; name comes from name enquiry.
    const dest = await http.put('/profiles/payout-destination').set(creator.auth).send({ bankCode: '000013', bankName: 'GTBank', accountNumber: '0123456789' }).expect(200);
    expect(dest.body.accountName).toBe('MOCK ACCOUNT 6789');
    c = await http.get(`/campaigns/${id}`).set(creator.auth).expect(200);
    expect(c.body.status).toBe('payout_processing');

    await ctx.app.get(PaymentsService).reconcileAll(0);
    c = await http.get(`/campaigns/${id}`).set(creator.auth).expect(200);
    expect(c.body.status).toBe('completed');

    // Transaction trail + payment references exist for both parties.
    const trail = c.body.history.map((h: { toState: string | null }) => h.toState).filter(Boolean);
    expect(trail).toEqual(expect.arrayContaining(['awaiting_funding', 'funded', 'submitted', 'under_review', 'approved', 'payout_processing', 'completed']));
    expect(c.body.transactions.every((t: { payazaReference: string }) => t.payazaReference.startsWith('AFC'))).toBe(true);
    const notes = await http.get('/notifications').set(creator.auth).expect(200);
    expect(notes.body.map((n: { title: string }) => n.title)).toEqual(expect.arrayContaining(['Campaign funded', 'Payment successful']));
  });

  it('revision limit, then dispute pauses payout until admin releases', async () => {
    const { http } = ctx;
    const { brand, creator, campaign } = await funded();
    const id = campaign.id;
    const reqId = campaign.requirements[0].id;
    const submit = (n: number) => http.post(`/campaigns/${id}/submissions`).set(creator.auth).send({ requirementId: reqId, contentUrl: `https://www.tiktok.com/@testcreator/video/730000000000000000${n}` }).expect(201);

    await submit(1);
    await verified(id, 'PARTIAL');
    await http.post(`/campaigns/${id}/revision`).set(brand.auth).send({ note: 'Show the handbag in daylight' }).expect(201);
    await submit(2);
    await verified(id);
    await http.post(`/campaigns/${id}/revision`).set(brand.auth).send({ note: 'Another change please' }).expect(409); // limit 1

    const subs = await ctx.prisma.submission.findMany({ where: { campaignId: id } });
    expect(subs).toHaveLength(2); // history kept
    expect(subs.filter((s) => s.superseded)).toHaveLength(1);

    let c = await http.post(`/campaigns/${id}/dispute`).set(creator.auth).send({ reason: 'Brand keeps adding requirements after agreement' }).expect(201);
    expect(c.body.status).toBe('disputed');
    await http.post(`/campaigns/${id}/approve`).set(brand.auth).expect(409); // paused

    const aauth = await makeAdmin(http, ctx.prisma);
    await http.get('/admin/overview').set(brand.auth).expect(403);
    const disputes = await http.get('/admin/disputes').set(aauth).expect(200);
    const d = disputes.body.find((x: { campaignId: string }) => x.campaignId === id);

    await http.put('/profiles/payout-destination').set(creator.auth).send({ bankCode: '000013', bankName: 'GTBank', accountNumber: '0123456789' }).expect(200);
    await http.post(`/admin/disputes/${d.id}/resolve`).set(aauth).send({ outcome: 'release', resolution: 'Work matches the original brief; releasing payment.' }).expect(201);
    await ctx.app.get(PaymentsService).reconcileAll(0);
    c = await http.get(`/campaigns/${id}`).set(brand.auth).expect(200);
    expect(c.body.status).toBe('completed');

    // Replaying a stored webhook never creates a second payout.
    const funding = c.body.transactions.find((t: { kind: string }) => t.kind === 'FUNDING');
    await http.post('/webhooks/payaza').send({ transaction_reference: funding.payazaReference, transaction_status: 'Completed' }).expect(200);
    const hooks = await http.get('/admin/webhooks').set(aauth).expect(200);
    const hook = hooks.body.find((h: { reference: string }) => h.reference === funding.payazaReference);
    await http.post(`/admin/webhooks/${hook.id}/replay`).set(aauth).expect(201);
    const payouts = await ctx.prisma.transaction.count({ where: { campaignId: id, kind: 'PAYOUT', status: 'successful' } });
    expect(payouts).toBe(1);
  });

  it('verdict rules', () => {
    const ok = { kind: 'objective' as const, passed: true };
    expect(verdictFor([{ ...ok, label: 'Post is published and public' }, { label: 'Red bag', kind: 'ai', passed: true, confidence: 0.9 }])).toBe('PASS');
    expect(verdictFor([{ ...ok, label: 'Post is published and public', passed: false }])).toBe('FAIL');
    expect(verdictFor([{ ...ok, label: 'Uses #x' }, { label: 'Red bag', kind: 'ai', passed: true, confidence: 0.3 }])).toBe('NEEDS_REVIEW');
    expect(verdictFor([{ ...ok, label: 'Uses #x' }, { ...ok, label: 'Uses #y' }, { ...ok, label: 'Mentions @b', passed: false }])).toBe('PARTIAL');
  });
});
