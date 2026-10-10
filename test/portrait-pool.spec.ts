import { describe, expect, it } from 'vitest';
import { loadAndValidateDataset } from '../prisma/demo-import/core.js';
import { buildPoolPlan, poolPublicUrl, poolStorageKey } from '../scripts/portrait-pool/core.js';
import { readFileSync } from 'node:fs';

describe('shared 10-portrait pool', () => {
  const creators = loadAndValidateDataset('services/ml/data/demo-v2').creators;
  const plan = buildPoolPlan(creators);

  it('creates 10 distinct slots and 500 deterministic assignments', () => {
    expect(plan.slots).toHaveLength(10);
    expect(new Set(plan.slots.map((slot) => slot.id)).size).toBe(10);
    expect(Object.keys(plan.assignments)).toHaveLength(500);
    expect(buildPoolPlan(creators)).toEqual(plan);
  });

  it('balances every portrait at exactly fifty creators', () => {
    expect(new Set(plan.slots.map((slot) => slot.creatorIds.length))).toEqual(new Set([50]));
  });

  it('keeps assignment groups category-local where possible and records boundary categories', () => {
    expect(plan.slots.every((slot) => slot.categories.length >= 1 && slot.categories.length <= 3)).toBe(true);
    expect(plan.slots.every((slot) => slot.representativeNiches.length > 0)).toBe(true);
  });

  it('builds stable storage keys and frontend-compatible URLs', () => {
    expect(poolStorageKey('portrait-001')).toBe('africre8/demo/portrait-pool/portrait-001.webp');
    expect(poolPublicUrl('https://api.example.test/', 'portrait-010')).toBe('https://api.example.test/media/africre8/demo/portrait-pool/portrait-010.webp');
  });

  it('keeps production avatars immutable and stores overrides in ML profiles', () => {
    const source = readFileSync('scripts/portrait-pool/cli.ts', 'utf8');
    expect(source).toContain('displayImageOverrideUrl');
    expect(source).not.toContain('creatorProfile.update');
    expect(source).not.toContain('portfolio:');
  });
});
