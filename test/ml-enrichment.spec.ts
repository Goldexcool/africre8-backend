import { describe, expect, it } from 'vitest';
import {
  OPERATIONAL_ML_NAMESPACE,
  assertApprovedEnrichmentTarget,
  mapOperationalCreator,
  mapOperationalOpportunity,
  operationalFormat,
} from '../prisma/ml-enrichment/core.js';
import { databaseIdentity } from '../prisma/demo-import/core.js';

const url =
  'postgresql://ignored:ignored@localhost:5432/africre8_existing_test';
const fingerprint = databaseIdentity(url).fingerprint;

describe('existing database ML enrichment safeguards', () => {
  const base = {
    databaseUrl: url,
    expectedFingerprint: fingerprint,
    confirmedFingerprint: fingerprint,
    targetLabel: 'railway-existing-primary',
    confirmedTargetLabel: 'railway-existing-primary',
  };

  it('allows a confirmed dry run without write authorization', () => {
    expect(
      assertApprovedEnrichmentTarget({ ...base, write: false }).fingerprint,
    ).toBe(fingerprint);
  });

  it('requires every write and backup confirmation independently', () => {
    expect(() =>
      assertApprovedEnrichmentTarget({ ...base, write: true }),
    ).toThrow(/ML_ENRICHMENT_ENABLED/);
    expect(() =>
      assertApprovedEnrichmentTarget({
        ...base,
        write: true,
        enabled: 'true',
        confirmation: 'ENRICH_EXISTING_ML_PROFILES',
        backupConfirmed: 'true',
        backupReference: 'backup-20261010',
        confirmedBackupReference: 'wrong',
      }),
    ).toThrow(/backup reference confirmation/);
    expect(
      assertApprovedEnrichmentTarget({
        ...base,
        write: true,
        enabled: 'true',
        confirmation: 'ENRICH_EXISTING_ML_PROFILES',
        backupConfirmed: 'true',
        backupReference: 'backup-20261010',
        confirmedBackupReference: 'backup-20261010',
      }).fingerprint,
    ).toBe(fingerprint);
  });
});

describe('operational ML mapping', () => {
  it('derives capabilities and rates without personal or popularity features', () => {
    const mapped = mapOperationalCreator({
      userId: 'creator-1',
      displayName: 'Creator',
      bio: 'Food tutorials',
      category: 'Food',
      niches: ['recipes'],
      portfolio: [],
      priceFromKobo: 15000000,
      availability: 'available',
      socials: [{ platform: 'tiktok', followers: 999999 }],
    });
    expect(mapped.scalar.namespace).toBe(OPERATIONAL_ML_NAMESPACE);
    expect(mapped.scalar.synthetic).toBe(false);
    expect(mapped.capabilities).toEqual([
      { platform: 'tiktok', format: operationalFormat('tiktok') },
    ]);
    expect(mapped.rates[0].normalizedUsd).toBe('100.00');
    expect(JSON.stringify(mapped)).not.toContain('followers');
  });

  it('maps only opportunities with explicit deliverable platforms', () => {
    const mapped = mapOperationalOpportunity({
      id: 'opp-1',
      brandId: 'brand-1',
      title: 'Launch',
      brief: 'Show the product',
      category: 'Food',
      budgetKobo: 30000000,
      deadlineDays: 7,
      deliverables: ['1 TikTok video'],
      brandIndustry: 'Retail',
    });
    expect('conflict' in mapped).toBe(false);
    if (!('conflict' in mapped)) {
      expect(mapped.scalar.synthetic).toBe(false);
      expect(mapped.scalar.requiredLanguages).toEqual([]);
      expect(mapped.scalar.requiredPlatforms).toEqual(['tiktok']);
    }
    expect(
      mapOperationalOpportunity({
        id: 'opp-2',
        brandId: 'brand-1',
        title: 'Launch',
        brief: 'Show it',
        category: 'Food',
        budgetKobo: 1,
        deadlineDays: 7,
        deliverables: ['One short video'],
      }),
    ).toHaveProperty('conflict');
  });
});
