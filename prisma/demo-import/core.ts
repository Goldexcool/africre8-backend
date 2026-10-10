import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const IMPORTER_VERSION = 'demo-v2-importer-v1';
export const EXPECTED_NAMESPACE = 'africre8-demo-v2';
export const PUBLIC_FILES = ['brands.json', 'creators.json', 'images.json', 'opportunities.json', 'interactions.json'] as const;
export const EXPECTED_COUNTS = { creators: 500, brands: 50, opportunities: 150, interactions: 3000 } as const;
export const FORBIDDEN_KEYS = new Set(['generator_truth', 'reliability', 'delivery_consistency', 'work_quality', 'responsiveness']);
export const PLATFORMS = new Set(['instagram', 'tiktok', 'youtube', 'x', 'facebook']);

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type RecordJson = Record<string, any>;
export type DemoDataset = {
  root: string;
  manifest: RecordJson;
  manifestSha256: string;
  datasetFingerprint: string;
  brands: RecordJson[];
  creators: RecordJson[];
  images: RecordJson[];
  opportunities: RecordJson[];
  interactions: RecordJson[];
  eventSequence: Map<string, number>;
};

export type ImportSummary = {
  creators: number;
  brands: number;
  opportunities: number;
  interactions: number;
  socials: number;
  audienceMarkets: number;
  capabilities: number;
  commercialRates: number;
  journeys: number;
  contracts: number;
};

export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const recordHash = (value: unknown) => sha256(canonical(value));

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertUnique(rows: RecordJson[], key: string, label: string) {
  const values = rows.map((row) => row[key]);
  assert(values.every((value) => typeof value === 'string' && value.length > 0), `${label} has missing ${key}`);
  assert(new Set(values).size === values.length, `${label} has duplicate ${key}`);
}

function walkPrivate(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((child, index) => walkPrivate(child, `${path}[${index}]`));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [
    ...(FORBIDDEN_KEYS.has(key) ? [`${path}.${key}`] : []),
    ...walkPrivate(child, `${path}.${key}`),
  ]);
}

function validateCreator(row: RecordJson) {
  for (const key of ['id', 'display_name', 'bio', 'category', 'portfolio_description', 'content_tone', 'image_asset_id']) {
    assert(typeof row[key] === 'string' && row[key].length > 0, `creator ${row.id ?? '?'} missing ${key}`);
  }
  for (const key of ['niches', 'content_languages', 'audience_interests', 'creative_styles', 'production_capabilities', 'deliverable_capabilities', 'commercial_rates', 'socials']) {
    assert(Array.isArray(row[key]) && row[key].length > 0, `creator ${row.id} missing ${key}`);
  }
  assert(row.synthetic === true && row.namespace === EXPECTED_NAMESPACE, `creator ${row.id} lacks demo provenance`);
  assert(Array.isArray(row.audience?.markets) && row.audience.markets.length > 0, `creator ${row.id} missing audience markets`);
  const marketTotal = row.audience.markets.reduce((sum: number, item: RecordJson) => sum + Number(item.share_percent), 0);
  assert(Math.abs(marketTotal - 100) < 0.001, `creator ${row.id} audience shares do not total 100`);
  const capabilities = new Set(row.deliverable_capabilities.map((item: RecordJson) => `${item.platform}:${item.format}`));
  for (const item of row.deliverable_capabilities) assert(PLATFORMS.has(item.platform), `creator ${row.id} has invalid platform`);
  for (const rate of row.commercial_rates) {
    assert(capabilities.has(`${rate.platform}:${rate.format}`), `creator ${row.id} rate lacks capability`);
    assert(rate.base_rate?.rate_version === 'synthetic-usd-reference-v1', `creator ${row.id} has unexpected rate version`);
    assert(Number(rate.base_rate?.normalized_usd) > 0, `creator ${row.id} has invalid normalized rate`);
  }
}

function validateOpportunity(row: RecordJson) {
  for (const key of ['id', 'brand_id', 'title', 'brief', 'category']) assert(typeof row[key] === 'string' && row[key], `opportunity ${row.id ?? '?'} missing ${key}`);
  for (const key of ['deliverables', 'required_languages', 'required_platforms', 'compatible_niches']) assert(Array.isArray(row[key]) && row[key].length > 0, `opportunity ${row.id} missing ${key}`);
  assert(row.synthetic === true && row.namespace === EXPECTED_NAMESPACE, `opportunity ${row.id} lacks demo provenance`);
  assert(row.budget?.rate_version === 'synthetic-usd-reference-v1' && Number(row.budget?.normalized_usd) > 0, `opportunity ${row.id} invalid budget`);
}

function buildEventSequence(events: RecordJson[], creatorIds: Set<string>, opportunityIds: Set<string>) {
  const groups = new Map<string, RecordJson[]>();
  for (const event of events) {
    assert(event.synthetic === true && event.namespace === EXPECTED_NAMESPACE, `event ${event.id} lacks demo provenance`);
    assert(creatorIds.has(event.creator_id), `event ${event.id} references unknown creator`);
    assert(opportunityIds.has(event.opportunity_id), `event ${event.id} references unknown opportunity`);
    const group = groups.get(event.journey_id) ?? [];
    group.push(event);
    groups.set(event.journey_id, group);
  }
  const sequence = new Map<string, number>();
  for (const [journeyId, rows] of groups) {
    const byId = new Map(rows.map((row) => [row.id, row]));
    const roots = rows.filter((row) => row.previous_event_id == null);
    assert(roots.length === 1, `journey ${journeyId} must have one root`);
    let current: RecordJson | undefined = roots[0];
    const seen = new Set<string>();
    let index = 0;
    while (current) {
      assert(!seen.has(current.id), `journey ${journeyId} contains a cycle`);
      seen.add(current.id);
      sequence.set(current.id, index++);
      const next = rows.filter((row) => row.previous_event_id === current!.id);
      assert(next.length <= 1, `journey ${journeyId} branches at ${current.id}`);
      current = next[0];
    }
    assert(seen.size === byId.size, `journey ${journeyId} contains disconnected events`);
  }
  return sequence;
}

export function loadAndValidateDataset(root: string): DemoDataset {
  const absolute = resolve(root);
  const manifestBytes = readFileSync(resolve(absolute, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as RecordJson;
  assert(manifest.namespace === EXPECTED_NAMESPACE, `expected namespace ${EXPECTED_NAMESPACE}`);
  assert(manifest.schema_version === '2.0', 'unsupported demo schema version');
  const loaded: Record<string, RecordJson[]> = {};
  for (const file of PUBLIC_FILES) {
    const bytes = readFileSync(resolve(absolute, file));
    assert(sha256(bytes) === manifest.files_sha256?.[file], `checksum mismatch: ${file}`);
    loaded[file] = JSON.parse(bytes.toString('utf8'));
  }
  assert(loaded['creators.json'].length === EXPECTED_COUNTS.creators, 'expected 500 creators');
  assert(loaded['brands.json'].length === EXPECTED_COUNTS.brands, 'expected 50 brands');
  assert(loaded['opportunities.json'].length === EXPECTED_COUNTS.opportunities, 'expected 150 opportunities');
  assert(loaded['interactions.json'].length === EXPECTED_COUNTS.interactions, 'expected 3000 interactions');
  for (const [file, rows] of Object.entries(loaded)) {
    assert(walkPrivate(rows).length === 0, `${file} contains private generator fields`);
    assertUnique(rows, 'id', file);
  }
  const creators = loaded['creators.json'];
  const brands = loaded['brands.json'];
  const images = loaded['images.json'];
  const opportunities = loaded['opportunities.json'];
  const interactions = loaded['interactions.json'];
  creators.forEach(validateCreator);
  const imageById = new Map(images.map((row) => [row.id, row]));
  for (const creator of creators) {
    const image = imageById.get(creator.image_asset_id);
    assert(image?.creator_id === creator.id, `creator ${creator.id} has an invalid image reference`);
    assert(image.synthetic === true && image.exclude_from_ml_features === true, `creator ${creator.id} image provenance is invalid`);
  }
  opportunities.forEach(validateOpportunity);
  assert(new Set(brands.map((row) => row.id)).size === brands.length, 'duplicate brand IDs');
  const brandIds = new Set(brands.map((row) => row.id));
  for (const row of opportunities) assert(brandIds.has(row.brand_id), `opportunity ${row.id} references unknown brand`);
  const eventSequence = buildEventSequence(interactions, new Set(creators.map((row) => row.id)), new Set(opportunities.map((row) => row.id)));
  const datasetFingerprint = sha256(PUBLIC_FILES.map((file) => `${file}:${manifest.files_sha256[file]}`).join('\n'));
  return {
    root: absolute,
    manifest,
    manifestSha256: sha256(manifestBytes),
    datasetFingerprint,
    brands,
    creators,
    images,
    opportunities,
    interactions,
    eventSequence,
  };
}

export function summarize(dataset: DemoDataset): ImportSummary {
  return {
    creators: dataset.creators.length,
    brands: dataset.brands.length,
    opportunities: dataset.opportunities.length,
    interactions: dataset.interactions.length,
    socials: dataset.creators.reduce((sum, row) => sum + row.socials.length, 0),
    audienceMarkets: dataset.creators.reduce((sum, row) => sum + row.audience.markets.length, 0),
    capabilities: dataset.creators.reduce((sum, row) => sum + row.deliverable_capabilities.length, 0),
    commercialRates: dataset.creators.reduce((sum, row) => sum + row.commercial_rates.length, 0),
    journeys: new Set(dataset.interactions.map((row) => row.journey_id)).size,
    contracts: new Set(dataset.interactions.map((row) => row.contract_id).filter(Boolean)).size,
  };
}

export function databaseIdentity(urlText: string) {
  const url = new URL(urlText);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const canonicalTarget = `${url.protocol}//${url.hostname.toLowerCase()}:${url.port || '5432'}/${database}`;
  return { host: url.hostname.toLowerCase(), database, canonicalTarget, fingerprint: sha256(canonicalTarget) };
}

export function assertApprovedDemoTarget(input: {
  databaseUrl?: string;
  databaseEnvironment?: string;
  expectedFingerprint?: string;
  confirmedFingerprint?: string;
  importEnabled?: string;
  nodeEnvironment?: string;
  write: boolean;
}) {
  assert(input.databaseUrl, 'DATABASE_URL is required');
  const identity = databaseIdentity(input.databaseUrl);
  assert(input.databaseEnvironment === 'demo', 'DEMO_DATABASE_ENV must equal demo');
  assert(input.nodeEnvironment !== 'production', 'imports are disabled when NODE_ENV=production');
  assert(!/(prod|production|staging|railway)/i.test(`${identity.host}/${identity.database}`), 'production, staging and Railway targets are forbidden');
  assert(/(demo|test|local)/i.test(identity.database), 'database name must visibly identify a demo, test or local database');
  assert(input.expectedFingerprint === identity.fingerprint, 'DEMO_DATABASE_FINGERPRINT does not match DATABASE_URL');
  assert(input.confirmedFingerprint === identity.fingerprint, 'CLI fingerprint confirmation is missing or incorrect');
  if (input.write) assert(input.importEnabled === 'true', 'DEMO_DATA_IMPORT_ENABLED=true is required for writes');
  return identity;
}

export function syntheticEmail(kind: 'creator' | 'brand', sourceId: string) {
  return `${sourceId.toLowerCase().replace(/[^a-z0-9_-]+/g, '-') }@${kind}s.demo.africre8.invalid`;
}

export function unusablePasswordHash() {
  return `!demo-disabled-${randomBytes(32).toString('hex')}`;
}

export function legacyCreatorEmail(index: number, name: string) {
  if (index === 0) return 'creator.dev@africre8.app';
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '');
  return `${slug}@creators.africre8.app`;
}

export function parseReviewedMapping(path?: string): { creators: Record<string, string>; brands: Record<string, string> } {
  if (!path) return { creators: {}, brands: {} };
  const value = JSON.parse(readFileSync(resolve(path), 'utf8'));
  assert(value && typeof value === 'object', 'reviewed mapping must be an object');
  return { creators: value.creators ?? {}, brands: value.brands ?? {} };
}
