import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';

export const PORTRAIT_COUNT = 500;
export const PORTRAIT_SIZE = 512;
export const PORTRAIT_NAMESPACE = 'africre8/demo/creators';
export type CreatorRecord = Record<string, any>;
export type PortraitEntry = {
  creatorId: string;
  assetId: string;
  promptHash: string;
  status: 'pending' | 'generated' | 'uploaded' | 'failed';
  filePath: string;
  storageKey: string;
  contentHash?: string;
  byteSize?: number;
  width?: number;
  height?: number;
  format?: string;
  provider?: string;
  model?: string;
  generatedAt?: string;
  uploadedAt?: string;
  error?: string;
};
export type PortraitManifest = {
  version: '1.0';
  namespace: typeof PORTRAIT_NAMESPACE;
  synthetic: true;
  generatedSubjectsAreFictionalAdults: true;
  entries: PortraitEntry[];
};

const choice = <T>(id: string, values: readonly T[], offset: number) =>
  values[
    createHash('sha256').update(`${id}:${offset}`).digest()[0] % values.length
  ];
const HAIR = [
  'close-cropped natural hair',
  'short twists',
  'braided hair',
  'locs',
  'a natural afro',
  'a clean shaved hairstyle',
] as const;
const COMPLEXIONS = [
  'deep brown skin',
  'dark brown skin',
  'rich brown skin',
  'medium brown skin',
  'warm brown skin',
] as const;
const SETTINGS = [
  'a softly blurred creative studio',
  'a softly blurred urban outdoor setting',
  'a warm neutral editorial backdrop',
  'a contemporary home workspace',
] as const;
const WARDROBE = [
  'contemporary casual clothing',
  'smart creative-professional clothing',
  'modern understated clothing',
  'colorful contemporary clothing',
] as const;

export function buildPortraitPrompt(creator: CreatorRecord) {
  const interests = [
    ...(creator.niches ?? []),
    ...(creator.creative_styles ?? []),
  ]
    .slice(0, 4)
    .join(', ');
  return [
    'Use case: photorealistic-natural.',
    'Asset type: square creator marketplace profile portrait.',
    `Primary request: a photorealistic portrait of one fictional Black African adult creator associated with ${creator.residence?.city}, ${creator.residence?.country}; location guides only the setting and must not stereotype appearance.`,
    `Creative context: ${creator.category}; ${interests}.`,
    `Visual direction selected for dataset diversity, not asserted demographic truth: ${choice(creator.id, COMPLEXIONS, 1)}, ${choice(creator.id, HAIR, 2)}, ${choice(creator.id, WARDROBE, 3)}.`,
    `Scene/backdrop: ${choice(creator.id, SETTINGS, 4)} with subtle cues suitable for the creator niche.`,
    'Composition: head-and-shoulders, face clearly visible, centered with generous margin for circular cropping, square frame.',
    'Lighting: realistic soft editorial photography, natural skin texture, accurate exposure.',
    'Constraints: one fictional adult only; do not infer gender; no celebrity or known-person likeness; no logos, flags, text, signature, watermark, exaggerated cultural costume, or stereotype.',
  ].join('\n');
}

export const sha256 = (value: Buffer | string) =>
  createHash('sha256').update(value).digest('hex');
export function safeCreatorId(id: string) {
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(id))
    throw new Error(`invalid creator ID: ${id}`);
  return id;
}
export const portraitStorageKey = (id: string) =>
  `${PORTRAIT_NAMESPACE}/${safeCreatorId(id)}.webp`;
export const portraitPublicUrl = (publicUrl: string, id: string) =>
  `${publicUrl.replace(/\/$/, '')}/media/${portraitStorageKey(id)}`;

export function createManifest(
  creators: CreatorRecord[],
  images: CreatorRecord[],
  outputRoot: string,
): PortraitManifest {
  if (creators.length !== PORTRAIT_COUNT || images.length !== PORTRAIT_COUNT)
    throw new Error('expected exactly 500 creators and image records');
  const byCreator = new Map(images.map((image) => [image.creator_id, image]));
  const entries = creators.map((creator) => {
    const image = byCreator.get(creator.id);
    if (!image || image.id !== creator.image_asset_id)
      throw new Error(`invalid image mapping for ${creator.id}`);
    return {
      creatorId: creator.id,
      assetId: image.id,
      promptHash: sha256(buildPortraitPrompt(creator)),
      status: 'pending' as const,
      filePath: resolve(
        outputRoot,
        'files',
        `${safeCreatorId(creator.id)}.webp`,
      ),
      storageKey: portraitStorageKey(creator.id),
    };
  });
  if (new Set(entries.map((entry) => entry.assetId)).size !== PORTRAIT_COUNT)
    throw new Error('duplicate image asset mapping');
  return {
    version: '1.0',
    namespace: PORTRAIT_NAMESPACE,
    synthetic: true,
    generatedSubjectsAreFictionalAdults: true,
    entries,
  };
}

export async function optimizeWebp(input: Buffer) {
  let quality = 84;
  let output = await sharp(input)
    .rotate()
    .resize(PORTRAIT_SIZE, PORTRAIT_SIZE, {
      fit: 'cover',
      position: 'attention',
    })
    .webp({ quality, effort: 6 })
    .toBuffer();
  while (output.length > 150 * 1024 && quality > 58) {
    quality -= 4;
    output = await sharp(input)
      .rotate()
      .resize(PORTRAIT_SIZE, PORTRAIT_SIZE, {
        fit: 'cover',
        position: 'attention',
      })
      .webp({ quality, effort: 6 })
      .toBuffer();
  }
  return output;
}

export async function inspectPortrait(entry: PortraitEntry) {
  if (!existsSync(entry.filePath))
    return { valid: false as const, reason: 'missing' };
  const bytes = readFileSync(entry.filePath);
  let metadata;
  try {
    metadata = await sharp(bytes).metadata();
  } catch {
    return { valid: false as const, reason: 'corrupt' };
  }
  if (metadata.format !== 'webp')
    return { valid: false as const, reason: 'format' };
  if (metadata.width !== PORTRAIT_SIZE || metadata.height !== PORTRAIT_SIZE)
    return { valid: false as const, reason: 'dimensions' };
  return {
    valid: true as const,
    contentHash: sha256(bytes),
    byteSize: bytes.length,
    width: metadata.width,
    height: metadata.height,
    format: metadata.format,
  };
}
