import { describe, expect, it } from 'vitest';
import { loadAndValidateDataset } from '../prisma/demo-import/core.js';
import {
  campaignStatus,
  deterministicUuid,
  eventOf,
  groupJourneys,
  interestStatus,
  normalizedKobo,
} from '../prisma/demo-operational/core.js';

const dataset = loadAndValidateDataset('services/ml/data/demo-v2');
const journeys = groupJourneys(dataset.interactions);

describe('synthetic operational planning', () => {
  it('uses deterministic valid UUIDs', () => {
    expect(deterministicUuid('campaign:syn_contract_00001')).toBe(
      deterministicUuid('campaign:syn_contract_00001'),
    );
    expect(deterministicUuid('campaign:syn_contract_00001')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('maps exactly the published journeys and contracts', () => {
    expect(journeys.size).toBe(430);
    expect(
      [...journeys.values()].filter((rows) => eventOf(rows, 'contract')),
    ).toHaveLength(360);
  });

  it('derives collaboration and campaign states only from evidence', () => {
    for (const rows of journeys.values()) {
      expect(['ACCEPTED', 'DECLINED', 'EXPIRED']).toContain(
        interestStatus(rows),
      );
      if (eventOf(rows, 'contract'))
        expect([
          'completed',
          'cancelled',
          'disputed',
          'revision_required',
          'under_review',
          'submitted',
          'in_progress',
        ]).toContain(campaignStatus(rows));
    }
  });

  it('normalizes contract amounts safely for the operational NGN schema', () => {
    expect(normalizedKobo('100.00')).toBe(15_000_000);
    expect(() => normalizedKobo('999999999')).toThrow(
      /unsafe normalized campaign amount/,
    );
  });
});
