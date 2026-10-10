import { describe, expect, it } from 'vitest';
import {
  syntheticAvatarSvg,
  validSyntheticCreatorId,
} from '../src/uploads/demo-avatar.js';

describe('synthetic demo creator avatars', () => {
  it('generates deterministic, explicitly synthetic SVG without remote content', () => {
    const first = syntheticAvatarSvg('creator-one');
    expect(first).toBe(syntheticAvatarSvg('creator-one'));
    expect(first).toContain('Synthetic AfriCre8 demo creator avatar');
    expect(first).toContain('not a photograph of a real person');
    expect(first).not.toMatch(/<(?:image|script)[^>]+(?:href|src)=/i);
  });

  it('accepts stable dataset IDs and rejects path-like input', () => {
    expect(validSyntheticCreatorId('usr_demo_creator')).toBe(true);
    expect(validSyntheticCreatorId('tunde-adeyemi')).toBe(true);
    expect(validSyntheticCreatorId('../creator')).toBe(false);
    expect(validSyntheticCreatorId('creator.svg')).toBe(false);
  });
});
