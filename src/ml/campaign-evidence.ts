import type { DisputeStatus } from '../generated/prisma/client.js';

/** What a finished campaign needs to become credibility evidence. */
export type EvidenceCampaign = {
  id: string;
  creatorId: string;
  status: string;
  createdAt: Date;
  fundedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
  submissions: { late: boolean; superseded: boolean; createdAt: Date }[];
  disputes: { status: DisputeStatus; createdAt: Date; resolvedAt: Date | null }[];
};

/** The creator's work was accepted (paid or being paid). */
const ACCEPTED = new Set(['approved', 'payout_processing', 'payout_failed', 'completed']);

/** Who a resolved dispute counts against: a refund means the work fell short, a split is shared, release/revision clears the creator. */
const ATTRIBUTION: Partial<Record<DisputeStatus, string>> = {
  RESOLVED_REFUND: 'creator',
  RESOLVED_SPLIT: 'shared',
  RESOLVED_RELEASE: 'neither',
  RESOLVED_REVISION: 'neither',
};

const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Real campaigns as the credibility model's event chains (invitation → … → completion), so a creator's score moves
 * with the work they finish in the app, not only with imported demo history. Only settled outcomes count:
 * accepted work, or a resolved dispute. Ratings are not stored per campaign, so there is no rating event.
 */
export function campaignEvidence(c: EvidenceCampaign): Record<string, unknown>[] {
  const dispute = c.disputes.find((d) => d.status !== 'OPEN' && ATTRIBUTION[d.status]);
  if (!ACCEPTED.has(c.status) && !dispute) return [];
  const submitted = c.submissions.filter((s) => !s.superseded);
  if (!submitted.length) return [];

  const start = c.fundedAt ?? c.createdAt;
  const submittedAt = submitted.reduce((a, s) => (s.createdAt > a ? s.createdAt : a), submitted[0].createdAt);
  const steps: [string, Date, Record<string, unknown>][] = [
    ['invitation', c.createdAt, {}],
    ['match', c.createdAt, {}],
    ['negotiation', c.createdAt, {}],
    ['contract', start, {}],
    ['submission', submittedAt, { deliverables_received: true, late: submitted.some((s) => s.late) }],
  ];
  if (dispute) {
    const refunded = dispute.status === 'RESOLVED_REFUND';
    steps.push(['verification', dispute.createdAt, { outcome: refunded ? 'fail' : 'pass', evidence_sufficient: true }]);
    steps.push(['dispute', dispute.createdAt, {}]);
    steps.push(['dispute_resolved', dispute.resolvedAt ?? dispute.createdAt, { attribution: ATTRIBUTION[dispute.status] }]);
    if (!refunded) steps.push(['completion', c.completedAt ?? dispute.resolvedAt ?? c.updatedAt, { accepted_fulfillment: true }]);
  } else {
    steps.push(['verification', c.completedAt ?? c.updatedAt, { outcome: 'pass', evidence_sufficient: true }]);
    steps.push(['completion', c.completedAt ?? c.updatedAt, { accepted_fulfillment: true }]);
  }

  // Dates can only go forward along the chain (the model sorts by date, then id).
  let floor = steps[0][1];
  return steps.map(([type, at, details], i) => {
    if (at < floor) at = floor;
    floor = at;
    return {
      id: `${c.id}:${String(i).padStart(2, '0')}`,
      journey_id: c.id,
      creator_id: c.creatorId,
      opportunity_id: c.id,
      contract_id: i >= 3 ? c.id : null,
      event_type: type,
      occurred_at: day(at),
      previous_event_id: i ? `${c.id}:${String(i - 1).padStart(2, '0')}` : null,
      details,
    };
  });
}
