import 'dotenv/config';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import OpenAI from 'openai';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import { consolidationDatabaseIdentity } from '../../prisma/consolidation/core.js';
import {
  buildPortraitPrompt,
  createManifest,
  inspectPortrait,
  optimizeWebp,
  portraitPublicUrl,
  type PortraitManifest,
} from './core.js';

const DATA_ROOT = resolve('services/ml/data/demo-v2');
const OUTPUT_ROOT = resolve(
  process.env.PORTRAIT_OUTPUT_DIR ?? 'services/ml/generated/portraits',
);
const MANIFEST_PATH = resolve(OUTPUT_ROOT, 'manifest.json');
const mode = process.argv[2] ?? 'plan';
const arg = (name: string) =>
  process.argv
    .find((item) => item.startsWith(`${name}=`))
    ?.slice(name.length + 1);
const creators = JSON.parse(
  readFileSync(resolve(DATA_ROOT, 'creators.json'), 'utf8'),
);
const images = JSON.parse(
  readFileSync(resolve(DATA_ROOT, 'images.json'), 'utf8'),
);
const model = process.env.PORTRAIT_MODEL ?? 'gpt-image-1';
const quality = process.env.PORTRAIT_QUALITY ?? 'medium';
const unitCost = Number(process.env.PORTRAIT_ESTIMATED_UNIT_COST_USD ?? '0.07');
if (!Number.isFinite(unitCost) || unitCost <= 0)
  throw new Error('PORTRAIT_ESTIMATED_UNIT_COST_USD must be positive');
const estimatedCost = Number((creators.length * unitCost).toFixed(2));
const readSafe = (path: string) => {
  try {
    return readFileSync(path);
  } catch {
    return undefined;
  }
};

function loadManifest() {
  const baseline = createManifest(creators, images, OUTPUT_ROOT);
  const bytes = readSafe(MANIFEST_PATH);
  if (!bytes) return baseline;
  const existing = JSON.parse(bytes.toString()) as PortraitManifest;
  const previous = new Map(
    existing.entries.map((entry) => [entry.creatorId, entry]),
  );
  baseline.entries = baseline.entries.map((entry) => {
    const old = previous.get(entry.creatorId);
    return old &&
      old.assetId === entry.assetId &&
      old.promptHash === entry.promptHash
      ? {
          ...entry,
          ...old,
          filePath: entry.filePath,
          storageKey: entry.storageKey,
        }
      : entry;
  });
  return baseline;
}

function save(manifest: PortraitManifest) {
  mkdirSync(resolve(OUTPUT_ROOT, 'files'), { recursive: true });
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
}
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function verify(manifest: PortraitManifest) {
  const hashes = new Map<string, string>();
  const failures: { creatorId: string; reason: string }[] = [];
  let totalBytes = 0;
  for (const entry of manifest.entries) {
    const result = await inspectPortrait(entry);
    if (!result.valid) {
      failures.push({ creatorId: entry.creatorId, reason: result.reason });
      continue;
    }
    const duplicate = hashes.get(result.contentHash);
    if (duplicate)
      failures.push({
        creatorId: entry.creatorId,
        reason: `duplicate of ${duplicate}`,
      });
    else hashes.set(result.contentHash, entry.creatorId);
    totalBytes += result.byteSize;
  }
  return {
    expected: 500,
    validUnique: hashes.size,
    failures,
    totalBytes,
    storageMiB: Number((totalBytes / 1048576).toFixed(2)),
  };
}

if (mode === 'plan') {
  const report = await verify(loadManifest());
  console.log(
    JSON.stringify(
      {
        mode,
        provider: 'openai',
        model,
        quality,
        estimatedUnitCostUsd: unitCost,
        estimatedTotalCostUsd: estimatedCost,
        credentialsConfigured: !!process.env.OPENAI_API_KEY,
        concurrency: Number(process.env.PORTRAIT_CONCURRENCY ?? '2'),
        manifestPath: MANIFEST_PATH,
        expected: report.expected,
        validUnique: report.validUnique,
        missingOrInvalid: report.failures.length,
        failureSample: report.failures.slice(0, 10),
        totalBytes: report.totalBytes,
        storageMiB: report.storageMiB,
      },
      null,
      2,
    ),
  );
} else if (mode === 'verify') {
  const report = await verify(loadManifest());
  const byReason = report.failures.reduce<Record<string, number>>(
    (counts, failure) => ({
      ...counts,
      [failure.reason]: (counts[failure.reason] ?? 0) + 1,
    }),
    {},
  );
  console.log(
    JSON.stringify(
      {
        expected: report.expected,
        validUnique: report.validUnique,
        missingOrInvalid: report.failures.length,
        failuresByReason: byReason,
        failureSample: report.failures.slice(0, 20),
        totalBytes: report.totalBytes,
        storageMiB: report.storageMiB,
      },
      null,
      2,
    ),
  );
  if (report.validUnique !== 500 || report.failures.length)
    process.exitCode = 2;
} else if (mode === 'generate') {
  const approved = Number(arg('--approve-max-usd'));
  if (!process.env.OPENAI_API_KEY)
    throw new Error('OPENAI_API_KEY is required');
  if (!Number.isFinite(approved) || approved < estimatedCost)
    throw new Error(
      `paid generation requires --approve-max-usd=${estimatedCost} or greater`,
    );
  const manifest = loadManifest();
  save(manifest);
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const concurrency = Math.max(
    1,
    Math.min(5, Number(process.env.PORTRAIT_CONCURRENCY ?? '2')),
  );
  let cursor = 0;
  async function worker() {
    while (cursor < manifest.entries.length) {
      const entry = manifest.entries[cursor++];
      const existing = await inspectPortrait(entry);
      if (existing.valid) {
        Object.assign(entry, existing, {
          status: entry.status === 'uploaded' ? 'uploaded' : 'generated',
          error: undefined,
        });
        save(manifest);
        continue;
      }
      const creator = creators.find((row: any) => row.id === entry.creatorId)!;
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          const response = await client.images.generate({
            model,
            prompt: buildPortraitPrompt(creator),
            size: '1024x1024',
            quality,
            output_format: 'png',
          } as any);
          const encoded = response.data?.[0]?.b64_json;
          if (!encoded) throw new Error('provider returned no image bytes');
          const webp = await optimizeWebp(Buffer.from(encoded, 'base64'));
          mkdirSync(resolve(OUTPUT_ROOT, 'files'), { recursive: true });
          writeFileSync(entry.filePath, webp);
          const checked = await inspectPortrait(entry);
          if (!checked.valid)
            throw new Error(
              `optimized file validation failed: ${checked.reason}`,
            );
          Object.assign(entry, checked, {
            status: 'generated',
            provider: 'openai',
            model,
            generatedAt: new Date().toISOString(),
            error: undefined,
          });
          save(manifest);
          break;
        } catch (error: any) {
          entry.status = 'failed';
          entry.error = String(error?.message ?? error);
          save(manifest);
          if (attempt === 5) break;
          const retryAfter =
            Number(error?.headers?.get?.('retry-after')) * 1000;
          await sleep(
            Number.isFinite(retryAfter) && retryAfter > 0
              ? retryAfter
              : 1000 * 2 ** (attempt - 1),
          );
        }
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const report = await verify(manifest);
  console.log(JSON.stringify(report, null, 2));
  if (report.validUnique !== 500) process.exitCode = 2;
} else if (mode === 'upload') {
  if (
    process.env.PORTRAIT_R2_UPLOAD_ENABLED !== 'true' ||
    arg('--confirm-upload') !== 'UPLOAD_VALIDATED_SYNTHETIC_PORTRAITS'
  )
    throw new Error(
      'R2 upload requires the explicit enable switch and confirmation',
    );
  for (const key of [
    'R2_ENDPOINT',
    'R2_BUCKET',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'PUBLIC_URL',
  ])
    if (!process.env[key]) throw new Error(`${key} is required`);
  const manifest = loadManifest();
  const report = await verify(manifest);
  if (report.validUnique !== 500 || report.failures.length)
    throw new Error(
      'upload refused until all 500 portraits are valid and unique',
    );
  const client = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  for (const entry of manifest.entries) {
    const checked = await inspectPortrait(entry);
    if (!checked.valid)
      throw new Error(
        `portrait ${entry.creatorId} became invalid before upload`,
      );
    if (
      entry.status === 'uploaded' &&
      entry.contentHash === checked.contentHash
    )
      continue;
    Object.assign(entry, checked);
    await client.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET!,
        Key: entry.storageKey,
        Body: readFileSync(entry.filePath),
        ContentType: 'image/webp',
        CacheControl: 'public, max-age=31536000, immutable',
        Metadata: {
          synthetic: 'true',
          creator: entry.creatorId,
          sha256: entry.contentHash!,
        },
      }),
    );
    entry.status = 'uploaded';
    entry.uploadedAt = new Date().toISOString();
    save(manifest);
  }
  writeFileSync(
    resolve(OUTPUT_ROOT, 'uploaded-avatar-urls.json'),
    JSON.stringify(
      Object.fromEntries(
        manifest.entries.map((entry) => [
          entry.creatorId,
          portraitPublicUrl(process.env.PUBLIC_URL!, entry.creatorId),
        ]),
      ),
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ uploaded: 500, namespace: manifest.namespace }, null, 2),
  );
} else if (mode === 'apply-db') {
  if (
    process.env.PORTRAIT_DATABASE_APPLY_ENABLED !== 'true' ||
    arg('--confirm-apply') !== 'APPLY_UPLOADED_SYNTHETIC_PORTRAITS'
  )
    throw new Error(
      'database apply requires the explicit enable switch and confirmation',
    );
  if (!process.env.DATABASE_URL || !process.env.PUBLIC_URL)
    throw new Error('DATABASE_URL and PUBLIC_URL are required');
  const identity = consolidationDatabaseIdentity(process.env.DATABASE_URL);
  if (arg('--confirm-target-fingerprint') !== identity.fingerprint)
    throw new Error(
      'database target fingerprint confirmation is missing or incorrect',
    );
  const manifest = loadManifest();
  if (manifest.entries.some((entry) => entry.status !== 'uploaded'))
    throw new Error('database apply refused until every portrait is uploaded');
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  try {
    let updated = 0;
    for (const entry of manifest.entries) {
      const provenance = await prisma.datasetRecordProvenance.findFirst({
        where: {
          namespace: 'africre8-unified-v1',
          entityType: 'creator',
          sourceId: entry.creatorId,
          synthetic: true,
        },
      });
      if (!provenance) continue;
      const result = await prisma.creatorProfile.updateMany({
        where: { userId: provenance.entityId },
        data: {
          avatarUrl: portraitPublicUrl(process.env.PUBLIC_URL, entry.creatorId),
        },
      });
      updated += result.count;
    }
    console.log(
      JSON.stringify(
        {
          targetFingerprint: identity.fingerprint,
          updatedSyntheticCreators: updated,
          productionCreatorsUpdated: 0,
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
} else throw new Error(`unknown mode: ${mode}`);
