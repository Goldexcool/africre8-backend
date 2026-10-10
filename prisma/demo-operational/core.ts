import { createHash } from 'node:crypto';

export type JsonRecord = Record<string, any>;

export function deterministicUuid(key: string) {
  const bytes = Buffer.from(
    createHash('sha256')
      .update(`africre8-demo-operational-v1:${key}`)
      .digest()
      .subarray(0, 16),
  );
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function groupJourneys(events: JsonRecord[]) {
  const grouped = new Map<string, JsonRecord[]>();
  for (const event of events) {
    const rows = grouped.get(event.journey_id) ?? [];
    rows.push(event);
    grouped.set(event.journey_id, rows);
  }
  for (const rows of grouped.values())
    rows.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  return grouped;
}

export function eventOf(rows: JsonRecord[], type: string) {
  return rows.find((event) => event.event_type === type);
}

export function campaignStatus(rows: JsonRecord[]) {
  if (eventOf(rows, 'completion')) return 'completed' as const;
  if (eventOf(rows, 'cancellation')) return 'cancelled' as const;
  if (eventOf(rows, 'dispute') && !eventOf(rows, 'dispute_resolved'))
    return 'disputed' as const;
  const latestRevision = [...rows]
    .reverse()
    .find((event) =>
      ['revision_requested', 'revision_submitted'].includes(event.event_type),
    );
  if (latestRevision?.event_type === 'revision_requested')
    return 'revision_required' as const;
  if (eventOf(rows, 'verification')) return 'under_review' as const;
  if (eventOf(rows, 'submission')) return 'submitted' as const;
  return 'in_progress' as const;
}

export function interestStatus(rows: JsonRecord[]) {
  if (eventOf(rows, 'match')) return 'ACCEPTED' as const;
  if (eventOf(rows, 'withdrawal')) return 'DECLINED' as const;
  return 'EXPIRED' as const;
}

export function normalizedKobo(amount: unknown) {
  const value = Math.round(Number(amount) * 1500 * 100);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_000_000_000)
    throw new Error(`unsafe normalized campaign amount: ${amount}`);
  return value;
}
