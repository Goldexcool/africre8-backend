import { campaignEvidence, type EvidenceCampaign } from '../src/ml/campaign-evidence.js';

const d = (s: string) => new Date(s);
const base: EvidenceCampaign = {
  id: 'c1', creatorId: 'cr1', status: 'completed',
  createdAt: d('2026-09-01'), fundedAt: d('2026-09-02'), completedAt: d('2026-09-10'), updatedAt: d('2026-09-10'),
  submissions: [{ late: true, superseded: false, createdAt: d('2026-09-05') }],
  disputes: [],
};

// The credibility model rejects broken chains, so the shape is the contract (checked against the Python scorer by hand).
describe('campaignEvidence', () => {
  it('turns accepted work into one linked chain ending in completion', () => {
    const ev = campaignEvidence(base);
    expect(ev.map((e) => e.event_type)).toEqual(['invitation', 'match', 'negotiation', 'contract', 'submission', 'verification', 'completion']);
    ev.forEach((e, i) => expect(e.previous_event_id).toBe(i ? ev[i - 1].id : null));
    expect(ev[4].details).toEqual({ deliverables_received: true, late: true });
  });

  it('counts a refund dispute against the creator and stops before completion', () => {
    const ev = campaignEvidence({ ...base, status: 'refunded', disputes: [{ status: 'RESOLVED_REFUND', createdAt: d('2026-09-06'), resolvedAt: d('2026-09-07') }] });
    expect(ev.at(-1)).toMatchObject({ event_type: 'dispute_resolved', details: { attribution: 'creator' } });
  });

  it('ignores campaigns that are not settled', () => {
    expect(campaignEvidence({ ...base, status: 'in_progress' })).toEqual([]);
    expect(campaignEvidence({ ...base, status: 'cancelled' })).toEqual([]);
  });
});
