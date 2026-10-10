import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadAndValidateDataset,
  recordHash,
} from '../prisma/demo-import/core.js';
import {
  CONSOLIDATION_NAMESPACE,
  assertApprovedConsolidationTarget,
  loadConsolidationScope,
  mapSyntheticCreator,
  validateScopeAgainstDataset,
} from '../prisma/consolidation/core.js';

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function scopeFile(value: Record<string, unknown>) {
  const root = resolve(
    tmpdir(),
    `africre8-consolidation-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(root, { recursive: true });
  temporary.push(root);
  const path = resolve(root, 'scope.json');
  writeFileSync(path, JSON.stringify(value));
  return path;
}

const emptyScope = {
  version: '1.0',
  namespace: CONSOLIDATION_NAMESPACE,
  syntheticCreatorIds: [],
  syntheticBrandIds: [],
  syntheticOpportunityIds: [],
  syntheticEvidenceCreatorIds: [],
  creatorIdentityMappings: {},
  brandIdentityMappings: {},
  opportunityIdentityMappings: {},
};

describe('consolidation scope', () => {
  it('validates an empty production-preserving scope', () => {
    const scope = loadConsolidationScope(scopeFile(emptyScope));
    expect(() =>
      validateScopeAgainstDataset(
        scope,
        loadAndValidateDataset('services/ml/data/demo-v2'),
      ),
    ).not.toThrow();
  });

  it('requires evidence identities and all related opportunities to be explicitly approved', () => {
    const dataset = loadAndValidateDataset('services/ml/data/demo-v2');
    const creatorId = dataset.interactions[0].creator_id;
    const path = scopeFile({
      ...emptyScope,
      syntheticEvidenceCreatorIds: [creatorId],
    });
    expect(() =>
      validateScopeAgainstDataset(loadConsolidationScope(path), dataset),
    ).toThrow(/must be an explicitly new synthetic identity/);
  });

  it('marks synthetic features and excludes private truth', () => {
    const creator = loadAndValidateDataset('services/ml/data/demo-v2')
      .creators[0];
    const mapped = mapSyntheticCreator(creator, false);
    expect(mapped.scalar.synthetic).toBe(false);
    expect(mapped.scalar.featureProvenance).toEqual({
      identity: 'production',
      recommendation_features: 'africre8-demo-v2',
    });
    expect(JSON.stringify(mapped)).not.toContain('generator_truth');
  });
});

describe('consolidation write safeguards', () => {
  const databaseUrl =
    'postgresql://ignored:ignored@localhost:5432/consolidation_test';
  const targetFingerprint = recordHash(
    'postgresql://localhost:5432/consolidation_test',
  );
  const base = {
    databaseUrl,
    targetLabel: 'reviewed-existing-railway',
    confirmedTargetLabel: 'reviewed-existing-railway',
    expectedTargetFingerprint: targetFingerprint,
    confirmedTargetFingerprint: targetFingerprint,
    actualProductionFingerprint: 'production-fingerprint',
    actualPlanHash: 'plan-hash',
  };

  it('permits a confirmed read-only plan', () => {
    expect(
      assertApprovedConsolidationTarget({ ...base, write: false }).fingerprint,
    ).toBe(targetFingerprint);
  });

  it('requires exact plan, snapshot, backup, and write confirmations', () => {
    expect(() =>
      assertApprovedConsolidationTarget({
        ...base,
        write: true,
        enabled: 'true',
      }),
    ).toThrow(/consolidation confirmation/);
    expect(
      assertApprovedConsolidationTarget({
        ...base,
        write: true,
        enabled: 'true',
        confirmation: 'APPLY_REVIEWED_CONSOLIDATION',
        confirmedProductionFingerprint: 'production-fingerprint',
        confirmedPlanHash: 'plan-hash',
        backupConfirmed: 'true',
        backupReference: 'restored-backup-1',
        confirmedBackupReference: 'restored-backup-1',
      }).fingerprint,
    ).toBe(targetFingerprint);
  });
});
