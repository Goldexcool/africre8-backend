import { CampaignStateMachine } from '../src/campaigns/state-machine.js';
import { bootApp, cleanup, makeMatch, sampleTerms } from './helpers.js';

describe('Campaigns (e2e)', () => {
  let ctx: Awaited<ReturnType<typeof bootApp>>;

  beforeAll(async () => {
    ctx = await bootApp();
  });

  afterAll(async () => {
    await cleanup(ctx.prisma);
    await ctx.app.close();
  });

  it('propose → counter-edit resets acceptance → both accept same version → awaiting_funding', async () => {
    const { http } = ctx;
    const { brand, creator, matchId, conversationId } = await makeMatch(http);

    const created = await http.post('/campaigns').set(brand.auth).send({ matchId, ...sampleTerms() }).expect(201);
    const id = created.body.id;
    expect(created.body.status).toBe('pending_agreement');
    expect(created.body.feeKobo).toBe(1_600_000); // 8% of ₦200,000
    expect(created.body.requirements[0].hashtags).toEqual(['#adireatelier']);
    await http.post('/campaigns').set(brand.auth).send({ matchId, ...sampleTerms() }).expect(409); // one open campaign per match

    const msgs = await http.get(`/conversations/${conversationId}/messages`).set(creator.auth).expect(200);
    expect(msgs.body[0].text).toMatch(/Campaign proposed/);

    // Creator counters with a higher fee: version bumps and the brand must re-accept.
    const edited = await http.put(`/campaigns/${id}/terms`).set(creator.auth).send(sampleTerms({ amountNgn: 230000 })).expect(200);
    expect(edited.body.termsVersion).toBe(2);
    expect(edited.body.brandAcceptedAt).toBeNull();

    await http.post(`/campaigns/${id}/accept`).set(brand.auth).send({ termsVersion: 1 }).expect(409); // stale terms
    const accepted = await http.post(`/campaigns/${id}/accept`).set(brand.auth).send({ termsVersion: 2 }).expect(201);
    expect(accepted.body.status).toBe('awaiting_funding');
    expect(accepted.body.history.map((h: { action: string }) => h.action)).toContain('campaign.status');

    // Cannot be marked funded without a successful Payaza funding transaction.
    await expect(ctx.app.get(CampaignStateMachine).transition(id, 'funded')).rejects.toThrow(/still waiting for the payment provider/);
    // Cannot skip ahead.
    await expect(ctx.app.get(CampaignStateMachine).transition(id, 'completed')).rejects.toThrow(/waiting to be funded/);
    await http.post(`/campaigns/${id}/start`).set(creator.auth).expect(409);
  });
});
