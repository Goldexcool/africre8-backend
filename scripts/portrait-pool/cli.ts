import 'dotenv/config';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PrismaPg } from '@prisma/adapter-pg';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { consolidationDatabaseIdentity } from '../../prisma/consolidation/core.js';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import { buildPoolPlan, findSourceFile, inspectPoolFile, optimizePoolImage, poolPublicUrl } from './core.js';

const creators = JSON.parse(readFileSync('services/ml/data/demo-v2/creators.json', 'utf8'));
const plan = buildPoolPlan(creators);
const root = resolve(process.env.PORTRAIT_POOL_DIR ?? 'services/ml/generated/portrait-pool');
const sourceDir = resolve(root, 'source');
const outputDir = resolve(root, 'optimized');
const manifestPath = resolve(root, 'manifest.json');
const mode = process.argv[2] ?? 'plan';
const arg = (name: string) => process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
const manifest = { ...plan, slots: plan.slots.map((slot) => ({ ...slot, sourcePath: findSourceFile(sourceDir, slot.id), outputPath: resolve(outputDir, `${slot.id}.webp`) })) };

async function verify() {
  const hashes = new Map<string, string>();
  const failures: { id: string; reason: string }[] = [];
  let bytes = 0;
  for (const slot of manifest.slots) {
    const result = await inspectPoolFile(slot.outputPath);
    if (!result.valid) { failures.push({ id: slot.id, reason: result.reason }); continue; }
    if (hashes.has(result.hash)) failures.push({ id: slot.id, reason: `duplicate of ${hashes.get(result.hash)}` });
    else hashes.set(result.hash, slot.id);
    bytes += result.bytes;
  }
  return { expectedAssets: 50, validUniqueAssets: hashes.size, assignments: Object.keys(plan.assignments).length, minAssignments: Math.min(...plan.slots.map((slot) => slot.creatorIds.length)), maxAssignments: Math.max(...plan.slots.map((slot) => slot.creatorIds.length)), failures, totalBytes: bytes };
}

if (mode === 'plan') {
  console.log(JSON.stringify({ sourceDirectory: sourceDir, naming: 'portrait-001.(webp|png|jpg|jpeg) through portrait-050', suppliedSources: manifest.slots.filter((slot) => slot.sourcePath).length, expectedSources: 50, assignments: 500, assignmentsPerPortrait: 10, slotSummary: manifest.slots.map(({ id, categories, representativeNiches }) => ({ id, categories, representativeNiches })) }, null, 2));
} else if (mode === 'optimize') {
  const missing = manifest.slots.filter((slot) => !slot.sourcePath);
  if (missing.length) throw new Error(`missing ${missing.length} source assets; first missing: ${missing[0].id}`);
  mkdirSync(outputDir, { recursive: true });
  for (const slot of manifest.slots) writeFileSync(slot.outputPath, await optimizePoolImage(slot.sourcePath!));
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify(await verify(), null, 2));
} else if (mode === 'verify') {
  const report = await verify();
  console.log(JSON.stringify({ ...report, failures: report.failures.slice(0, 20) }, null, 2));
  if (report.validUniqueAssets !== 50 || report.failures.length) process.exitCode = 2;
} else if (mode === 'upload') {
  if (process.env.PORTRAIT_POOL_R2_UPLOAD_ENABLED !== 'true' || arg('--confirm-upload') !== 'UPLOAD_VALIDATED_50_PORTRAITS') throw new Error('portrait-pool upload is disabled');
  for (const key of ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) if (!process.env[key]) throw new Error(`${key} is required`);
  const report = await verify();
  if (report.validUniqueAssets !== 50 || report.failures.length) throw new Error('upload requires 50 valid unique portraits');
  const client = new S3Client({ region: 'auto', endpoint: process.env.R2_ENDPOINT, credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! } });
  for (const slot of manifest.slots) await client.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: slot.storageKey, Body: readFileSync(slot.outputPath), ContentType: 'image/webp', CacheControl: 'public, max-age=31536000, immutable', Metadata: { synthetic: 'true', pool: 'africre8-50-v1' } }));
  console.log(JSON.stringify({ uploaded: 50, namespace: plan.namespace }, null, 2));
} else if (mode === 'apply-db') {
  if (process.env.PORTRAIT_POOL_DATABASE_APPLY_ENABLED !== 'true' || arg('--confirm-apply') !== 'APPLY_50_PORTRAIT_POOL') throw new Error('portrait-pool database apply is disabled');
  if (!process.env.DATABASE_URL || !process.env.PUBLIC_URL) throw new Error('DATABASE_URL and PUBLIC_URL are required');
  const identity = consolidationDatabaseIdentity(process.env.DATABASE_URL);
  if (arg('--confirm-target-fingerprint') !== identity.fingerprint) throw new Error('target fingerprint mismatch');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  try {
    let updated = 0;
    for (const [creatorId, portraitId] of Object.entries(plan.assignments)) {
      const provenance = await prisma.datasetRecordProvenance.findFirst({ where: { namespace: 'africre8-unified-v1', entityType: 'creator', sourceId: creatorId, synthetic: true } });
      if (!provenance) continue;
      const result = await prisma.creatorMlProfile.updateMany({ where: { creatorId: provenance.entityId, synthetic: true }, data: { displayImageOverrideUrl: poolPublicUrl(process.env.PUBLIC_URL, portraitId as string) } });
      updated += result.count;
    }
    let productionOverrides = 0;
    const overridePath = arg('--production-overrides');
    if (overridePath) {
      const overrides = JSON.parse(readFileSync(resolve(overridePath), 'utf8')) as Record<string, string>;
      for (const [creatorId, portraitId] of Object.entries(overrides)) {
        if (!/^portrait-0(?:[0-4][0-9]|50)$/.test(portraitId)) throw new Error(`invalid pool ID for production override: ${portraitId}`);
        const result = await prisma.creatorMlProfile.updateMany({ where: { creatorId, synthetic: false }, data: { displayImageOverrideUrl: poolPublicUrl(process.env.PUBLIC_URL, portraitId) } });
        productionOverrides += result.count;
      }
    }
    console.log(JSON.stringify({ updatedSyntheticProfiles: updated, demoOnlyProductionOverrides: productionOverrides, storedProductionAvatarsUpdated: 0 }, null, 2));
  } finally { await prisma.$disconnect(); }
} else throw new Error(`unknown mode: ${mode}`);
