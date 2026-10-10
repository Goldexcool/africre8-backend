import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildPortraitPrompt,
  createManifest,
  inspectPortrait,
  optimizeWebp,
  portraitPublicUrl,
  portraitStorageKey,
} from '../scripts/portraits/core.js';
import { loadAndValidateDataset } from '../prisma/demo-import/core.js';

const root = mkdtempSync(join(tmpdir(), 'africre8-portraits-'));
mkdirSync(join(root, 'files'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('portrait pipeline', () => {
  const dataset = loadAndValidateDataset('services/ml/data/demo-v2');
  const manifest = createManifest(dataset.creators, dataset.images, root);

  it('creates exactly 500 unique and deterministic creator mappings', () => {
    expect(manifest.entries).toHaveLength(500);
    expect(new Set(manifest.entries.map((entry) => entry.creatorId)).size).toBe(
      500,
    );
    expect(new Set(manifest.entries.map((entry) => entry.assetId)).size).toBe(
      500,
    );
    expect(
      new Set(manifest.entries.map((entry) => entry.storageKey)).size,
    ).toBe(500);
    expect(createManifest(dataset.creators, dataset.images, root)).toEqual(
      manifest,
    );
  });

  it('uses profile context without treating generated visual direction as verified demographics', () => {
    const prompt = buildPortraitPrompt(dataset.creators[0]);
    expect(prompt).toContain(dataset.creators[0].category);
    expect(prompt).toContain(dataset.creators[0].residence.city);
    expect(prompt).toContain('not asserted demographic truth');
    expect(prompt).toContain('do not infer gender');
    expect(prompt).not.toContain(dataset.creators[0].display_name);
  });

  it('uses stable R2 keys and frontend-compatible API URLs', () => {
    expect(portraitStorageKey('creator-one')).toBe(
      'africre8/demo/creators/creator-one.webp',
    );
    expect(portraitPublicUrl('https://api.example.test/', 'creator-one')).toBe(
      'https://api.example.test/media/africre8/demo/creators/creator-one.webp',
    );
  });

  it('optimizes and validates a portrait as 512-square WebP', async () => {
    const input = await sharp({
      create: { width: 900, height: 700, channels: 3, background: '#754c38' },
    })
      .png()
      .toBuffer();
    const output = await optimizeWebp(input);
    const entry = manifest.entries[0];
    const { writeFileSync } = await import('node:fs');
    writeFileSync(entry.filePath, output);
    expect(await inspectPortrait(entry)).toMatchObject({
      valid: true,
      width: 512,
      height: 512,
      format: 'webp',
    });
  });
});
