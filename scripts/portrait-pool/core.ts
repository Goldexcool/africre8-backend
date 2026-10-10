import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';

export const POOL_SIZE = 10;
export const ASSIGNMENTS_PER_PORTRAIT = 50;
export const POOL_NAMESPACE = 'africre8/demo/portrait-pool';
export const poolId = (index: number) => `portrait-${String(index + 1).padStart(3, '0')}`;
export const poolStorageKey = (id: string) => `${POOL_NAMESPACE}/${id}.webp`;
export const poolPublicUrl = (publicUrl: string, id: string) => `${publicUrl.replace(/\/$/, '')}/media/${poolStorageKey(id)}`;
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

export function buildPoolPlan(creators: Record<string, any>[]) {
  if (creators.length !== 500) throw new Error('portrait pool requires exactly 500 creators');
  const ordered = [...creators].sort((a, b) => a.category.localeCompare(b.category) || hash(a.id).localeCompare(hash(b.id)));
  const slots = Array.from({ length: POOL_SIZE }, (_, index) => {
    const assigned = ordered.slice(index * ASSIGNMENTS_PER_PORTRAIT, (index + 1) * ASSIGNMENTS_PER_PORTRAIT);
    const frequency = new Map<string, number>();
    for (const creator of assigned) for (const niche of creator.niches ?? []) frequency.set(niche, (frequency.get(niche) ?? 0) + 1);
    return { id: poolId(index), sourceFile: `${poolId(index)}`, storageKey: poolStorageKey(poolId(index)), categories: [...new Set(assigned.map((creator) => creator.category))], representativeNiches: [...frequency].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([niche]) => niche), creatorIds: assigned.map((creator) => creator.id) };
  });
  return { version: '1.0', namespace: POOL_NAMESPACE, slots, assignments: Object.fromEntries(slots.flatMap((slot) => slot.creatorIds.map((creatorId) => [creatorId, slot.id]))) };
}

export function findSourceFile(sourceDir: string, id: string) {
  for (const extension of ['webp', 'png', 'jpg', 'jpeg']) { const path = resolve(sourceDir, `${id}.${extension}`); if (existsSync(path)) return path; }
  return undefined;
}

export async function optimizePoolImage(source: string) {
  return sharp(readFileSync(source)).rotate().resize(512, 512, { fit: 'cover', position: 'attention' }).webp({ quality: 82, effort: 6 }).toBuffer();
}

export async function inspectPoolFile(path: string) {
  if (!existsSync(path)) return { valid: false as const, reason: 'missing' };
  const bytes = readFileSync(path);
  try {
    const metadata = await sharp(bytes).metadata();
    if (metadata.format !== 'webp') return { valid: false as const, reason: 'format' };
    if (metadata.width !== 512 || metadata.height !== 512) return { valid: false as const, reason: 'dimensions' };
    return { valid: true as const, hash: hash(bytes), bytes: bytes.length };
  } catch { return { valid: false as const, reason: 'corrupt' }; }
}
