import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EXPECTED_COUNTS,
  EXPECTED_NAMESPACE,
  PUBLIC_FILES,
  assertApprovedDemoTarget,
  databaseIdentity,
  legacyCreatorEmail,
  loadAndValidateDataset,
  recordHash,
  summarize,
  syntheticEmail,
  syntheticCreatorAvatarUrl,
} from '../prisma/demo-import/core.js';

const ROOT = resolve('services/ml/data/demo-v2');
const FIXTURE = resolve('prisma/seed-data/creators.json');
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function linkedDataset() {
  const root = resolve(tmpdir(), `africre8-demo-import-${Date.now()}-${Math.random()}`);
  mkdirSync(root, { recursive: true });
  temporary.push(root);
  linkSync(resolve(ROOT, 'manifest.json'), resolve(root, 'manifest.json'));
  for (const file of PUBLIC_FILES) linkSync(resolve(ROOT, file), resolve(root, file));
  return root;
}

describe('demo-v2 importer preflight', () => {
  it('validates manifest checksums, namespace, exact counts and relationships', () => {
    const dataset = loadAndValidateDataset(ROOT);
    const summary = summarize(dataset);
    expect(dataset.manifest.namespace).toBe(EXPECTED_NAMESPACE);
    expect(summary).toMatchObject(EXPECTED_COUNTS);
    expect(summary).toEqual({
      creators: 500,
      brands: 50,
      opportunities: 150,
      interactions: 3000,
      socials: 1285,
      audienceMarkets: 2000,
      capabilities: 2631,
      commercialRates: 2631,
      journeys: 430,
      contracts: 360,
    });
    expect(dataset.eventSequence.size).toBe(3000);
    expect(dataset.images).toHaveLength(500);
    expect(dataset.images.filter((image) => image.status === 'not_generated')).toHaveLength(500);
    expect(dataset.images.filter((image) => image.public_url)).toHaveLength(0);
    expect(new Set(dataset.images.map((image) => image.creator_id))).toEqual(new Set(dataset.creators.map((creator) => creator.id)));
  });

  it('builds stable, self-hosted synthetic avatar references', () => {
    expect(syntheticCreatorAvatarUrl('https://api.example.test/', 'creator-one')).toBe('https://api.example.test/demo-media/creators/creator-one.svg');
    expect(() => syntheticCreatorAvatarUrl(undefined, 'creator-one')).toThrow(/PUBLIC_URL/);
  });

  it('rejects a changed public dataset file', () => {
    const root = linkedDataset();
    rmSync(resolve(root, 'creators.json'));
    writeFileSync(resolve(root, 'creators.json'), `${readFileSync(resolve(ROOT, 'creators.json'), 'utf8')}\n`);
    expect(() => loadAndValidateDataset(root)).toThrow(/checksum mismatch: creators.json/);
  });

  it('never loads generator truth as an import input', () => {
    expect(PUBLIC_FILES).not.toContain('generator_truth.json');
    const source = readFileSync(resolve('prisma/demo-import/core.ts'), 'utf8');
    expect(source).not.toContain("readFileSync(resolve(absolute, 'generator_truth.json'))");
  });

  it('preserves all 50 original fixture identities in demo-v2', () => {
    const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { id: string; name: string }[];
    const creators = new Map(loadAndValidateDataset(ROOT).creators.map((row) => [row.id, row]));
    expect(fixture).toHaveLength(50);
    for (const row of fixture) {
      expect(creators.get(row.id)?.display_name).toBe(row.name);
      expect(creators.get(row.id)?.source.kind).toBe('enriched_fixture');
    }
    expect(legacyCreatorEmail(0, fixture[0].name)).toBe('creator.dev@africre8.app');
  });

  it('uses stable source keys and hashes for idempotent reruns', () => {
    const creator = loadAndValidateDataset(ROOT).creators[0];
    expect(recordHash(creator)).toBe(recordHash(JSON.parse(JSON.stringify(creator))));
    expect(syntheticEmail('creator', creator.id)).toContain('@creators.demo.africre8.invalid');
  });
});

describe('demo database restrictions', () => {
  const url = 'postgresql://ignored:ignored@localhost:5432/africre8_demo';
  const fingerprint = databaseIdentity(url).fingerprint;

  it('accepts a fully confirmed disposable demo target for dry run', () => {
    expect(assertApprovedDemoTarget({ databaseUrl: url, databaseEnvironment: 'demo', expectedFingerprint: fingerprint, confirmedFingerprint: fingerprint, importEnabled: 'false', nodeEnvironment: 'test', write: false }).fingerprint).toBe(fingerprint);
  });

  it('requires an additional write opt-in', () => {
    expect(() => assertApprovedDemoTarget({ databaseUrl: url, databaseEnvironment: 'demo', expectedFingerprint: fingerprint, confirmedFingerprint: fingerprint, importEnabled: 'false', nodeEnvironment: 'test', write: true })).toThrow(/DEMO_DATA_IMPORT_ENABLED=true/);
  });

  it.each([
    ['production environment', { databaseUrl: url, databaseEnvironment: 'demo', expectedFingerprint: fingerprint, confirmedFingerprint: fingerprint, importEnabled: 'true', nodeEnvironment: 'production', write: true }],
    ['staging name', { databaseUrl: 'postgresql://x:x@localhost:5432/africre8_staging', databaseEnvironment: 'demo', expectedFingerprint: databaseIdentity('postgresql://x:x@localhost:5432/africre8_staging').fingerprint, confirmedFingerprint: databaseIdentity('postgresql://x:x@localhost:5432/africre8_staging').fingerprint, importEnabled: 'true', nodeEnvironment: 'test', write: true }],
    ['Railway host', { databaseUrl: 'postgresql://x:x@db.railway.internal:5432/africre8_demo', databaseEnvironment: 'demo', expectedFingerprint: databaseIdentity('postgresql://x:x@db.railway.internal:5432/africre8_demo').fingerprint, confirmedFingerprint: databaseIdentity('postgresql://x:x@db.railway.internal:5432/africre8_demo').fingerprint, importEnabled: 'true', nodeEnvironment: 'test', write: true }],
  ])('rejects %s', (_label, input) => expect(() => assertApprovedDemoTarget(input)).toThrow());
});

describe('operational isolation', () => {
  it('does not write synthetic history through operational delegates', () => {
    const importer = readFileSync(resolve('prisma/import-demo-v2.ts'), 'utf8');
    for (const forbidden of ['tx.campaign.', 'tx.submission.', 'tx.verificationRun.', 'tx.dispute.', 'tx.transaction.', 'tx.auditLog.', 'tx.payoutDestination.']) {
      expect(importer).not.toContain(forbidden);
    }
    expect(importer).toContain('tx.demoMlEvidenceEvent.upsert');
    expect(importer).toContain('prisma.$transaction');
  });
});
